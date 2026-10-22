import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { BehaviorAnalysisResponse, CustomDateRange, DataScope, RangeKey } from '../types';
import { parseBehaviorProjectFields } from '../utils/contracts/behaviorProjects';

/**
 * Debounce for background refreshes. One scan or sync can emit several
 * `stats-updated` events in a row, and every reload re-aggregates the whole
 * selected range, so bursts collapse into one request.
 */
export const BEHAVIOR_REFRESH_DEBOUNCE_MS = 400;

/** `YYYY-MM-DD` of `now` in the selected zone; the host date if the zone is unusable. */
export function selectedZoneDay(timeZone: string, now = new Date()): string {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
}

/**
 * Date bounds sent with a behavior-analysis request. Only `custom` carries an
 * explicit inclusive local-date range. Presets keep the Stats v2 dashboard
 * meaning and are resolved by the backend in the selected timezone (today,
 * this week from Monday, this month from the 1st, this year from January 1st,
 * each up to now; `all` covers the most recent 731 local days), so the client
 * sends no synthetic bounds for them. `meta.start` / `meta.end` of the
 * response are the source of truth for the analysed dates.
 */
export function behaviorRangeBounds(range: RangeKey, customRange: CustomDateRange | null): { start?: string; end?: string } {
  if (range === 'custom') return customRange ? { start: customRange.start, end: customRange.end } : {};
  return {};
}

function sameBehaviorSnapshot(previous: BehaviorAnalysisResponse | null, next: BehaviorAnalysisResponse): boolean {
  return previous !== null && JSON.stringify(previous) === JSON.stringify(next);
}

/**
 * Local behavior analysis for the active behavior view.
 *
 * - `loading`: no result for the current query yet (first load or a query
 *   change). A query change clears `data` so an old range is never shown as
 *   the new one.
 * - `refreshing`: the same query is being reloaded (manual `reload`, a scan or
 *   sync finishing, a return to the window after one of those or a new day)
 *   while the previous `data` stays on screen. An unchanged result keeps its
 *   object identity.
 * - `updatedAt`: ISO time the shown result was received; a failed refresh
 *   keeps the previous result and time and reports `error`.
 */
export function useBehaviorAnalysis({
  scope,
  range,
  customRange,
  timezone,
  active = true,
}: { scope: DataScope; range: RangeKey; customRange: CustomDateRange | null; timezone: string; active?: boolean }) {
  const [data, setData] = useState<BehaviorAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [projectFilter, setProjectFilterState] = useState<string[]>([]);
  const requestId = useRef(0);
  // Query identity of the result currently held in `data`.
  const dataQueryKey = useRef<string | null>(null);
  // Background refresh state, shared with the subscription effect below.
  // A read of the current query has been sent and not settled yet.
  const inFlight = useRef(false);
  // A ledger update arrived after the newest read began.
  const ledgerStale = useRef(false);
  // Selected-zone date the shown result was read on, to notice a new day.
  const loadedDay = useRef<{ timezone: string; day: string } | null>(null);
  // Settles once `stats-updated` is registered (or failed to register); every
  // read waits for it, so no update can slip in before the listener exists.
  const listenerReady = useRef<Promise<void>>(Promise.resolve());
  // Scheduling hooks of the live subscription: a new read supersedes a pending
  // background refresh, and a settled read re-runs once if updates came in.
  const backgroundRefresh = useRef<{ cancel: () => void; settled: () => void } | null>(null);
  const setProjectFilter = useCallback((keys: string[]) => {
    const next = [...new Set(keys.filter((key) => key.length > 0))];
    setProjectFilterState((current) => (
      current.length === next.length && current.every((key, index) => key === next[index]) ? current : next
    ));
  }, []);

  const reload = useCallback(async () => {
    const id = ++requestId.current;
    backgroundRefresh.current?.cancel();
    const reset = (message: string) => {
      dataQueryKey.current = null;
      loadedDay.current = null;
      inFlight.current = false;
      setLoading(false);
      setRefreshing(false);
      setData(null);
      setUpdatedAt(null);
      setError(message);
    };
    if (!active) {
      reset('');
      return;
    }
    if (scope !== 'local') {
      reset('行为分析只提供本机账本聚合；云端模式不支持完整行为分析。');
      return;
    }
    const bounds = behaviorRangeBounds(range, customRange);
    if (range === 'custom' && (!bounds.start || !bounds.end)) {
      reset('请选择完整日期区间。');
      return;
    }
    const queryKey = JSON.stringify([range, bounds.start ?? null, bounds.end ?? null, timezone, projectFilter]);
    if (dataQueryKey.current === queryKey) {
      setRefreshing(true);
    } else {
      dataQueryKey.current = null;
      loadedDay.current = null;
      setData(null);
      setUpdatedAt(null);
      setRefreshing(false);
      setLoading(true);
      setError('');
    }
    inFlight.current = true;
    await listenerReady.current;
    if (id !== requestId.current) return;
    // This read covers every update seen so far.
    ledgerStale.current = false;
    const day = selectedZoneDay(timezone);
    try {
      // v1.2 project fields are checked here; a broken project section is dropped whole.
      const request: { query: Record<string, unknown>; projects?: string[] } = {
        query: {
          range,
          start: bounds.start ?? null,
          end: bounds.end ?? null,
          timezone,
          machines: [],
          tools: [],
          models: [],
          search: null,
          tokenMode: 'effective',
        },
      };
      // 空筛选不带 `projects`，与旧客户端的请求形状相同。
      if (projectFilter.length > 0) request.projects = projectFilter;
      const response = parseBehaviorProjectFields(await invoke<BehaviorAnalysisResponse>('get_local_behavior_analysis', request));
      if (id !== requestId.current) return;
      dataQueryKey.current = queryKey;
      loadedDay.current = { timezone, day };
      setData((previous) => (sameBehaviorSnapshot(previous, response) ? previous : response));
      setUpdatedAt(new Date().toISOString());
      setError('');
    } catch (cause) {
      if (id === requestId.current) setError(`加载本机行为分析失败：${String(cause)}`);
    } finally {
      if (id === requestId.current) {
        inFlight.current = false;
        setLoading(false);
        setRefreshing(false);
        backgroundRefresh.current?.settled();
      }
    }
  }, [active, customRange, projectFilter, range, scope, timezone]);

  const reloadRef = useRef(reload);
  useEffect(() => { reloadRef.current = reload; }, [reload]);

  // While the view is active, a finished scan or sync (`stats-updated`)
  // reloads the same query, debounced. Every reload re-aggregates the whole
  // range and cannot be cancelled in the backend, so the triggers stay narrow:
  // - an update while the window is hidden waits for it to become visible;
  // - becoming visible reloads only after such an update, on a new local day
  //   in the selected zone, or when the event listener could not register;
  // - updates during a running read collapse into one reload after it settles;
  // - a new read (query change, manual reload) or hiding the window cancels a
  //   pending refresh.
  // Declared before the load effect: that first read waits for the listener
  // registration, so an update between the two cannot be missed. A layout
  // effect like the load effect below (T10.201): layout effects run before
  // passive ones, so a passive effect here would register after the read.
  const live = active && scope === 'local';
  useLayoutEffect(() => {
    if (!live) return undefined;
    let disposed = false;
    const stops: Array<() => void> = [];
    let eventsUnavailable = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const visible = () => document.visibilityState === 'visible';
    const cancel = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const schedule = () => {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        // A running read re-schedules through `settled` if it is outdated.
        if (!disposed && visible() && !inFlight.current) void reloadRef.current();
      }, BEHAVIOR_REFRESH_DEBOUNCE_MS);
    };
    const newDay = () => {
      const loaded = loadedDay.current;
      return loaded !== null && selectedZoneDay(loaded.timezone) !== loaded.day;
    };
    const onStatsUpdated = () => {
      ledgerStale.current = true;
      if (visible()) schedule();
    };
    const onVisibilityChange = () => {
      if (!visible()) cancel();
      else if (eventsUnavailable || ledgerStale.current || newDay()) schedule();
    };
    backgroundRefresh.current = {
      cancel,
      settled: () => {
        if (!disposed && visible() && ledgerStale.current) schedule();
      },
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    const track = (stop: () => void) => {
      if (disposed) stop();
      else stops.push(stop);
    };
    listenerReady.current = listen('stats-updated', () => { if (!disposed) onStatsUpdated(); })
      .then(track)
      .catch((cause: unknown) => {
        // Without the event, every return to the window reloads instead.
        eventsUnavailable = true;
        console.warn('行为分析未能监听账本更新，改为窗口重新可见时重新读取：', cause);
      });
    // 关闭或授权过期时先丢掉筛选，避免下一次请求带上 projects 得到 project_dimension_disabled。
    void listen<{ state?: string }>('project-index-updated', (event) => {
      if (disposed) return;
      const state = event.payload?.state;
      if (state === 'disabled' || state === 'consent_required') {
        setProjectFilterState((current) => (current.length === 0 ? current : []));
      }
      onStatsUpdated();
    }).then(track).catch((cause: unknown) => {
      console.warn('行为分析未能监听项目索引更新：', cause);
    });
    return () => {
      disposed = true;
      cancel();
      backgroundRefresh.current = null;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stops.forEach((stop) => stop());
    };
  }, [live]);

  // T10.201（T10.179 评审 O-1）：`useLayoutEffect`, not `useEffect` — cloud → local
  // (or any query-identity change) leaves the previous `error`/`data` committed
  // until this runs. `reload`'s synchronous prefix (down to the first `await`)
  // clears `error` and sets `loading` before the browser paints, so the stale
  // cloud-mode message never flashes as a `role="alert"` banner. An ordinary
  // effect fires after paint, which is exactly the one committed frame where
  // the old error was visible with the new scope already showing local's body.
  useLayoutEffect(() => { void reload(); }, [reload]);
  return { data, loading, refreshing, error, updatedAt, reload, projectFilter, setProjectFilter };
}
