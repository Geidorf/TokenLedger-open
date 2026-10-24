import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { BehaviorAnalysisResponse, DataScope, StatsData } from '../types';
import { beginRequest, isCurrentRequest, normalizeStatsQuery, parseStatsDataContract, queryEchoMatches } from '../utils/frontendContracts';
import { parseBehaviorProjectFields } from '../utils/contracts/behaviorProjects';
import { parseBudgetSettings, type BudgetRule } from './useBudget';
import type { ReportPeriod } from '../utils/periodReport';

export interface PeriodReportData {
  current: StatsData;
  previous: StatsData | null;
  behavior: BehaviorAnalysisResponse | null;
  budgetRules: BudgetRule[];
}

/** 与看板同一条命令、同一份查询形状读一段本地日期闭区间。 */
async function loadRange(scope: DataScope, start: string, end: string, timezone: string): Promise<StatsData> {
  const query = normalizeStatsQuery({
    range: 'custom',
    start,
    end,
    timezone,
    machines: [],
    tools: [],
    models: [],
    search: null,
    tokenMode: 'effective',
  });
  const response = parseStatsDataContract(await invoke<unknown>('get_cached_stats', {
    scope,
    range: 'custom',
    start,
    end,
    deviceFilter: 'all_cloud',
    timezone,
    machines: query.machines,
    tools: query.tools,
    models: query.models,
    search: query.search,
    tokenMode: query.tokenMode,
  }));
  if (response.meta?.query && !queryEchoMatches(response.meta.query, query)) {
    throw new Error('统计响应与所选周期不一致，请重试。');
  }
  return response;
}

async function loadBehavior(start: string, end: string, timezone: string): Promise<BehaviorAnalysisResponse | null> {
  try {
    return parseBehaviorProjectFields(await invoke<BehaviorAnalysisResponse>('get_local_behavior_analysis', {
      query: { range: 'custom', start, end, timezone, machines: [], tools: [], models: [], search: null, tokenMode: 'effective' },
    }));
  } catch {
    // 会话排行只是报告的一节；读不到时这一节标不可得，其余照常生成。
    return null;
  }
}

async function loadBudgetRules(): Promise<BudgetRule[]> {
  try {
    return parseBudgetSettings(await invoke<unknown>('get_budget_settings')).rules;
  } catch {
    return [];
  }
}

export async function loadPeriodReportData(scope: DataScope, period: ReportPeriod, timezone: string): Promise<PeriodReportData> {
  const [current, previous, behavior, budgetRules] = await Promise.all([
    loadRange(scope, period.start, period.end, timezone),
    // 上一期读不到只影响「与上期对比」，不让整份报告失败。
    loadRange(scope, period.previousStart, period.previousEnd, timezone).catch(() => null),
    scope === 'local' ? loadBehavior(period.start, period.end, timezone) : Promise.resolve(null),
    loadBudgetRules(),
  ]);
  return { current, previous, behavior, budgetRules };
}

export const RUNNING_REPORT_REFRESH_MS = 5 * 60 * 1000;

/** 报告页的数据：所选期次一变就重读；本机统计更新（`stats-updated`）时静默刷新。 */
export function usePeriodReport({ scope, period, timezone, active }: {
  scope: DataScope;
  period: ReportPeriod;
  timezone: string;
  active: boolean;
}) {
  const [data, setData] = useState<PeriodReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const key = `${scope}|${period.start}|${period.end}|${period.previousStart}|${period.previousEnd}|${timezone}`;
  const loadedKey = useRef<string | null>(null);

  const reload = useCallback(async () => {
    if (!active) return;
    const id = beginRequest(requestId);
    if (loadedKey.current !== key) {
      setData(null);
      setLoading(true);
    }
    setError('');
    try {
      const next = await loadPeriodReportData(scope, period, timezone);
      if (!isCurrentRequest(requestId, id)) return;
      loadedKey.current = key;
      setData(next);
    } catch (cause) {
      if (!isCurrentRequest(requestId, id)) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrentRequest(requestId, id)) setLoading(false);
    }
    // period 的字段都已在 key 里。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 网关记账不发 stats-updated：进行中的一期在窗口可见时每 5 分钟、以及回到窗口时重读。
  const running = !period.complete;
  useEffect(() => {
    if (!active || !running) return undefined;
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    const timer = window.setInterval(refreshIfVisible, RUNNING_REPORT_REFRESH_MS);
    window.addEventListener('focus', refreshIfVisible);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [active, running, reload]);

  useEffect(() => {
    if (!active) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen('stats-updated', () => void reload())
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [active, reload]);

  return { data, loading, error, reload };
}

export interface PeriodReportSettings {
  weekly: boolean;
  monthly: boolean;
}

export function parsePeriodReportSettings(value: unknown): PeriodReportSettings {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return { weekly: record.weekly === true, monthly: record.monthly === true };
}

/** 每周一 / 每月 1 日的提醒开关（`src-tauri/src/period_report.rs`）。 */
export function usePeriodReportSettings() {
  const [settings, setSettings] = useState<PeriodReportSettings>({ weekly: false, monthly: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // 没读到已存设置前不许保存：后端整份替换，按默认值写会关掉另一个已开的提醒。
  const [loaded, setLoaded] = useState(false);
  const saveId = useRef(0);

  useEffect(() => {
    let active = true;
    invoke<unknown>('get_period_report_settings')
      .then((value) => {
        // 已经保存过就以保存结果为准，迟到的初读不覆盖。
        if (!active || saveId.current !== 0) return;
        setSettings(parsePeriodReportSettings(value));
        setLoaded(true);
      })
      .catch(() => { if (active) setError('读取报告提醒设置失败'); });
    return () => { active = false; };
  }, []);

  const save = useCallback(async (next: PeriodReportSettings) => {
    if (!loaded) return;
    const id = beginRequest(saveId);
    const previous = settings;
    setSettings(next);
    setSaving(true);
    setError('');
    try {
      const saved = parsePeriodReportSettings(await invoke<unknown>('set_period_report_settings', { settings: next }));
      if (isCurrentRequest(saveId, id)) setSettings(saved);
    } catch {
      if (!isCurrentRequest(saveId, id)) return;
      setSettings(previous);
      setError('报告提醒设置未保存，请重试');
    } finally {
      if (isCurrentRequest(saveId, id)) setSaving(false);
    }
  }, [loaded, settings]);

  return { settings, loaded, saving, error, save };
}
