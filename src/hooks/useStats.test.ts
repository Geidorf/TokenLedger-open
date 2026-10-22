import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AppSettings, StatsData } from '../types';
import { snapshotRangeKey, useStats, type UseStatsProps } from './useStats';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.reject(new Error('fixture stats unavailable'))),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

describe('snapshotRangeKey（T10.185：custom 带时区；T10.200：预设也带，评审 P3-3）', () => {
  it('同一对起止日期在不同时区下产生不同的键，防止互相冒充“最近可信数据”', () => {
    const bounds = { start: '2026-07-01', end: '2026-07-14' };
    const shanghai = snapshotRangeKey('custom', bounds, 'Asia/Shanghai');
    const losAngeles = snapshotRangeKey('custom', bounds, 'America/Los_Angeles');
    expect(shanghai).not.toBe(losAngeles);
    expect(shanghai).toBe(snapshotRangeKey('custom', { ...bounds }, 'Asia/Shanghai'));
  });

  it('起止日期不同则键不同，与已有行为一致', () => {
    const a = snapshotRangeKey('custom', { start: '2026-07-01', end: '2026-07-14' }, 'Asia/Shanghai');
    const b = snapshotRangeKey('custom', { start: '2026-07-02', end: '2026-07-14' }, 'Asia/Shanghai');
    expect(a).not.toBe(b);
  });

  it('预设范围的键也带时区：同一个“本月”在两个时区下是两段不同的时间（T10.185 评审 P3-3）', () => {
    expect(snapshotRangeKey('month', null, 'Asia/Shanghai')).toBe('month::Asia/Shanghai');
    expect(snapshotRangeKey('month', null, 'America/Los_Angeles')).toBe('month::America/Los_Angeles');
    expect(snapshotRangeKey('today', null, 'Asia/Shanghai')).not.toBe(snapshotRangeKey('today', null, 'UTC'));
  });

  it('自定义范围尚未选定日期时回退到 custom:unset，不受时区影响', () => {
    expect(snapshotRangeKey('custom', null, 'Asia/Shanghai')).toBe('custom:unset');
  });
});

/** Builds every `useStats` prop with an inert default so each test only overrides what it exercises. */
function statsPropsFixture(overrides: Partial<UseStatsProps> = {}): UseStatsProps {
  return {
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
    ...overrides,
  };
}

describe('useStats changeRange（T10.185 评审 P3-1：开始日期不得晚于请求时区的今天）', () => {
  beforeEach(() => {
    vi.mocked(listen).mockReset();
    // changeRange itself never awaits `listen`; this only keeps the hook's own
    // unrelated subscription effects (wallpaper/prices/quota-sync/stats) from
    // crashing on unmount, where they call `.then` on whatever `listen(...)`
    // returned. Matches the other describe blocks below, which set a
    // per-event implementation for the same reason.
    vi.mocked(listen).mockImplementation(async () => () => {});
  });

  it('拒绝晚于当前时区今天的自定义开始日期：清晰提示，范围与状态都不改变', () => {
    const showMessage = vi.fn();
    const { result } = renderHook(() => useStats(statsPropsFixture({ showMessage })));

    act(() => {
      result.current.changeRange('custom', { start: '2099-06-15', end: '2099-06-15' });
    });

    expect(showMessage).toHaveBeenCalledWith('error', expect.stringContaining('晚于当前时区的今天'));
    // Never the vague/misleading cloud-version-incompatible framing.
    expect(showMessage).not.toHaveBeenCalledWith('error', expect.stringContaining('云端版本不兼容'));
    expect(result.current.range).toBe('today');
    expect(result.current.customRange).toBeNull();
  });

  it('允许今天本身作为自定义范围的开始日期', () => {
    const showMessage = vi.fn();
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const { result } = renderHook(() => useStats(statsPropsFixture({ showMessage })));

    act(() => {
      result.current.changeRange('custom', { start: today, end: today });
    });

    expect(showMessage).not.toHaveBeenCalledWith('error', expect.stringContaining('晚于当前时区的今天'));
    expect(result.current.range).toBe('custom');
    expect(result.current.customRange).toEqual({ start: today, end: today });
  });
});

describe('useStats quota-sync-updated', () => {
  beforeEach(() => vi.mocked(listen).mockReset());

  it('同时刷新设置和额度同步状态，并处理设置读取的异步失败', async () => {
    let quotaSyncUpdated: (() => void) | undefined;
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      if (event === 'quota-sync-updated') quotaSyncUpdated = () => handler({} as never);
      return () => {};
    });
    const loadSettings = vi.fn(() => Promise.reject(new Error('settings read failed')));
    const loadQuotaSyncStatus = vi.fn(async () => {});
    const showMessage = vi.fn();
    const setCloudSetup = vi.fn();
    const refreshCloudStatus = vi.fn(async () => ({ configured: false, authenticated: false, email: '', userId: '' }));
    const loadDbInfo = vi.fn(async () => {});
    const loadPrices = vi.fn(async () => {});
    const loadDetails = vi.fn(async () => {});
    const setDetailFilters = vi.fn();
    const setDetails = vi.fn();
    const setEntitySelection = vi.fn();
    const changeTab = vi.fn();
    const setSettingsAnchor = vi.fn();
    const setBusy = vi.fn();
    const currentTimezone = () => 'Asia/Shanghai';
    const appSettings = {} as AppSettings;

    const { unmount } = renderHook(() => useStats({
      showMessage,
      activeCloudConfig: { supabase_url: '', supabase_key: '' },
      cloudStatus: { configured: false, authenticated: false, email: '', userId: '' },
      cloudStatusKnown: false,
      appSettings,
      setCloudSetup,
      refreshCloudStatus,
      loadDbInfo,
      loadQuotaSyncStatus,
      loadSettings,
      loadPrices,
      pricesDirty: false,
      activeTab: 'dashboard',
      loadDetails,
      setDetailFilters,
      setDetails,
      setEntitySelection,
      showTotalTokens: false,
      changeTab,
      setSettingsAnchor,
      setBusy,
      currentTimezone,
    }));

    await waitFor(() => expect(quotaSyncUpdated).toBeTypeOf('function'));
    await act(async () => {
      quotaSyncUpdated?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadSettings).toHaveBeenCalledTimes(1);
    expect(loadQuotaSyncStatus).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe('useStats stats-updated（T10.159 P2-1）', () => {
  beforeEach(() => vi.mocked(listen).mockReset());

  it('扫描或同步后的统计刷新同时重读数据库信息，待上传记录数不会停在旧值', async () => {
    let statsUpdated: (() => void) | undefined;
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      if (event === 'stats-updated') statsUpdated = () => handler({} as never);
      return () => {};
    });
    const loadDbInfo = vi.fn(async () => {});
    const props: UseStatsProps = {
      showMessage: vi.fn(),
      activeCloudConfig: { supabase_url: '', supabase_key: '' },
      cloudStatus: { configured: false, authenticated: false, email: '', userId: '' },
      cloudStatusKnown: false,
      appSettings: {} as AppSettings,
      setCloudSetup: vi.fn(),
      refreshCloudStatus: vi.fn(async () => ({ configured: false, authenticated: false, email: '', userId: '' })),
      loadDbInfo,
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

    const { unmount } = renderHook(() => useStats(props));
    // 订阅建立后的补偿刷新也重读一次，覆盖订阅前错过的事件。
    await waitFor(() => expect(statsUpdated).toBeTypeOf('function'));
    await waitFor(() => expect(loadDbInfo).toHaveBeenCalledTimes(1));

    await act(async () => {
      statsUpdated?.();
      await Promise.resolve();
    });
    expect(loadDbInfo).toHaveBeenCalledTimes(2);
    unmount();
  });
});

function statsFixture(input: number): StatsData {
  return {
    summary: {
      totalTokens: input,
      inputTokens: input,
      outputTokens: 0,
      cachedTokens: 0,
      totalCost: 1,
      totalRequests: 3,
      avgTokensPerReq: Math.round(input / 3),
    },
    tools: { codex: { name: 'codex', input, output: 0, cached: 0, total: input, cost: 1, requests: 3 } },
    models: {},
    trends: [],
    heatmap: {},
    history: [],
  };
}

type StatsRead = { scope?: string; range?: string; deviceFilter?: string; timezone?: string };
const statsReads = () => vi.mocked(invoke).mock.calls
  .filter(([command]) => command === 'get_cached_stats')
  .map(([, args]) => args as StatsRead);

describe('useStats 查询切换（T10.200）', () => {
  beforeEach(() => {
    vi.mocked(listen).mockReset();
    vi.mocked(listen).mockImplementation(async () => () => {});
    vi.mocked(invoke).mockClear();
  });

  afterEach(() => {
    vi.mocked(invoke).mockImplementation(() => Promise.reject(new Error('fixture stats unavailable')));
  });

  it('切换口径与设备在同一次渲染里进入加载态：没有“无数据、未加载、无错误”的那一拍', async () => {
    // 本机立即回数；云端请求一直挂着，好看清切换后的每一次渲染。
    vi.mocked(invoke).mockImplementation(((command: string, args?: StatsRead) => {
      if (command !== 'get_cached_stats') return Promise.reject(new Error(command));
      return args?.scope === 'local' ? Promise.resolve(statsFixture(1_000)) : new Promise(() => {});
    }) as typeof invoke);
    const props = statsPropsFixture({
      activeCloudConfig: { supabase_url: 'https://example.supabase.co', supabase_key: 'publishable-key' },
      cloudStatus: { configured: true, authenticated: true, email: 'a@example.test', userId: 'user-a' },
      cloudStatusKnown: true,
    });
    const renders: Array<{ stats: boolean; loading: boolean; error: string; scope: string; device: string }> = [];
    const { result } = renderHook(() => {
      const hook = useStats(props);
      renders.push({ stats: hook.stats !== null, loading: hook.statsLoading, error: hook.statsError, scope: hook.dataScope, device: hook.deviceFilter });
      return hook;
    });
    await waitFor(() => expect(statsReads()).toHaveLength(2));
    await waitFor(() => expect(result.current.stats).not.toBeNull());
    await waitFor(() => expect(result.current.statsLoading).toBe(false));
    const blankFrames = () => renders.filter((frame) => !frame.stats && !frame.loading && !frame.error);
    expect(blankFrames()).toEqual([]);

    act(() => result.current.selectCloudScope());
    expect(result.current.dataScope).toBe('cloud');
    expect(result.current.stats).toBeNull();
    expect(result.current.statsLoading).toBe(true);

    act(() => result.current.changeHeaderDevice('studio-pc'));
    expect(result.current.deviceFilter).toBe('studio-pc');
    expect(result.current.statsLoading).toBe(true);

    act(() => result.current.selectLocalScope());
    await waitFor(() => expect(result.current.statsLoading).toBe(false));
    expect(renders.some((frame) => frame.scope === 'cloud' && frame.device === 'studio-pc')).toBe(true);
    expect(blankFrames()).toEqual([]);
  });

  it('已在当前口径时再点一次什么都不做：真实错误留着，不清成空帧，也不重发请求', async () => {
    vi.mocked(invoke).mockImplementation((() => Promise.reject(new Error('database is locked'))) as typeof invoke);
    const props = statsPropsFixture({
      activeCloudConfig: { supabase_url: 'https://example.supabase.co', supabase_key: 'publishable-key' },
      cloudStatus: { configured: true, authenticated: true, email: 'a@example.test', userId: 'user-a' },
      cloudStatusKnown: true,
    });
    const { result } = renderHook(() => useStats(props));
    // 首读与订阅建立后的补偿读取都失败以后再点。
    await waitFor(() => expect(statsReads()).toHaveLength(2));
    await waitFor(() => expect(result.current.statsLoading).toBe(false));
    expect(result.current.statsError).toBe('加载本地数据失败: Error: database is locked');
    expect(result.current.stats).toBeNull();
    const reads = statsReads().length;

    act(() => result.current.selectLocalScope());
    expect(result.current.statsError).toBe('加载本地数据失败: Error: database is locked');
    expect(result.current.statsLoading).toBe(false);

    act(() => result.current.selectCloudScope());
    await waitFor(() => expect(result.current.statsError).toMatch(/^云端服务暂不可用：/));
    await waitFor(() => expect(result.current.statsLoading).toBe(false));
    const cloudError = result.current.statsError;
    const cloudReads = statsReads().length;
    expect(cloudReads).toBeGreaterThan(reads);

    act(() => result.current.selectCloudScope());
    expect(result.current.statsError).toBe(cloudError);
    expect(result.current.statsLoading).toBe(false);
    expect(statsReads()).toHaveLength(cloudReads);
  });

  it('换了时区后读取失败：不拿旧时区的预设快照冒充“最近可信数据”（T10.185 评审 P3-3）', async () => {
    let timezone = 'Asia/Shanghai';
    let fail = false;
    vi.mocked(invoke).mockImplementation(((command: string) => {
      if (command !== 'get_cached_stats') return Promise.reject(new Error(command));
      return fail ? Promise.reject(new Error('database is locked')) : Promise.resolve(statsFixture(2_000));
    }) as typeof invoke);
    const props = statsPropsFixture({ currentTimezone: () => timezone });
    const { result } = renderHook(() => useStats(props));
    await waitFor(() => expect(statsReads()).toHaveLength(2));
    await waitFor(() => expect(result.current.stats?.summary.inputTokens).toBe(2_000));
    act(() => result.current.changeRange('month'));
    await waitFor(() => expect(result.current.statsLoading).toBe(false));
    expect(result.current.stats?.summary.inputTokens).toBe(2_000);

    // 同一时区里失败：回落到本月的可信快照（原有行为）。
    fail = true;
    await act(async () => { await result.current.loadStats({ notifyOnError: false }); });
    expect(result.current.statsError).toBe('加载本地数据失败: Error: database is locked');
    expect(result.current.stats?.summary.inputTokens).toBe(2_000);

    // 换到洛杉矶后失败：那份快照是上海的本月，不能再拿来显示。
    timezone = 'America/Los_Angeles';
    await act(async () => { await result.current.loadStats({ notifyOnError: false }); });
    const lastRead = statsReads()[statsReads().length - 1];
    expect(lastRead?.timezone).toBe('America/Los_Angeles');
    expect(result.current.statsError).toBe('加载本地数据失败: Error: database is locked');
    expect(result.current.stats).toBeNull();
  });
});
