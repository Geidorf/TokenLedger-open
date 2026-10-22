import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DetailFilters } from '../components/LogsTable';
import type { BehaviorAnalysisResponse, CustomDateRange, UsageDetailsEnvelope } from '../types';
import type { SessionAnalysisRecord } from '../types/sessionAnalysis';
import { isUnavailableEnvelope, normalizeStatsQuery } from '../utils/frontendContracts';
import { selectedZoneDay } from './useBehaviorAnalysis';

/**
 * Sources whose local session files support per-turn analysis
 * (`session-analysis-v1`: Claude and Codex main sessions). Same rule as the
 * details table's 「分析整个会话」 entry.
 */
const SESSION_ANALYSIS_TOOLS = new Set(['claude', 'codex']);

export function supportsBehaviorSessionAnalysis(tool: string): boolean {
  return SESSION_ANALYSIS_TOOLS.has(tool.toLowerCase());
}

/** A behavior ranking session: sessions are keyed by (tool, opaque session ID). */
export interface BehaviorSessionRef {
  id: string;
  tool: string;
}

/**
 * The window a behavior result was analysed over: `meta.range/start/end/timezone`.
 * Presets are resolved by the backend at request time, so these dates, not the
 * current range selection, say which records the ranking counted.
 */
export type BehaviorAnalysedWindow = Pick<BehaviorAnalysisResponse['meta'], 'range' | 'start' | 'end' | 'timezone'>;

/** Details pages (50 rows each) scanned for one record of the session. */
export const BEHAVIOR_SESSION_LOOKUP_PAGES = 4;

const LOCAL_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** First local day of a preset window that ends on `today` (`YYYY-MM-DD`), like the backend. */
function presetStartDay(range: 'today' | 'week' | 'month' | 'year', today: string): string {
  if (range === 'today') return today;
  if (range === 'month') return `${today.slice(0, 7)}-01`;
  if (range === 'year') return `${today.slice(0, 4)}-01-01`;
  const value = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
  return new Date(value - ((new Date(value).getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The range a drill-down from the behavior ranking should open (review F2).
 * The pages it opens (专属看板, details) resolve the global range again at
 * "now". While the selected zone's calendar is still inside the analysed
 * preset window, that contains every ranked record, so the current range is
 * kept (`null`). Once the calendar has moved past it — a new day for 今日, a
 * new week, month or year — the analysed dates are returned, to be opened as a
 * custom range. `all` (no 731-day cap outside this page) and custom ranges
 * still resolve to windows that contain the analysed one.
 */
export function behaviorDrillRange(analysed: BehaviorAnalysedWindow, now = new Date()): CustomDateRange | null {
  if (analysed.range === 'all' || analysed.range === 'custom') return null;
  if (!LOCAL_DAY.test(analysed.start) || !LOCAL_DAY.test(analysed.end) || analysed.end < analysed.start) return null;
  return presetStartDay(analysed.range, selectedZoneDay(analysed.timezone, now)) <= analysed.start
    ? null
    : { start: analysed.start, end: analysed.end };
}

/**
 * Details filters for a ranked session: search its ID (details search covers
 * session_id) within its own tool, because the same session ID under another
 * tool is a different session. Every other filter is cleared.
 */
export function behaviorSessionDetailFilters(session: BehaviorSessionRef): DetailFilters {
  return { tools: [session.tool], models: [], machines: [], search: session.id };
}

/** What a session row opens: the details with `filters`, over `range` (see `behaviorDrillRange`) when it is set. */
export interface BehaviorSessionDrill {
  session: BehaviorSessionRef;
  filters: DetailFilters;
  range: CustomDateRange | null;
}

/**
 * Per-turn analysis starts from a ledger record ID, while the behavior ranking
 * only knows (tool, session ID). Find one record of that session through the
 * existing local details command, over the analysed dates as a custom range
 * (so a preset that has moved on since, for example past midnight, cannot hide
 * it; review F2) and filtered to the session's tool. Details search is a
 * case-insensitive substring match over tool/model/machine/session, so only an
 * exact session ID and tool match is accepted. Returns null when no record is
 * found (for example the ledger was cleaned up after the result was computed).
 */
export async function findBehaviorSessionRecord(
  session: BehaviorSessionRef,
  analysed: Pick<BehaviorAnalysedWindow, 'start' | 'end' | 'timezone'>,
): Promise<SessionAnalysisRecord | null> {
  const canonical = normalizeStatsQuery({
    range: 'custom',
    start: analysed.start,
    end: analysed.end,
    timezone: analysed.timezone,
    machines: [],
    tools: [session.tool],
    models: [],
    search: session.id,
    tokenMode: 'effective',
  });
  let cursor: string | null = null;
  for (let page = 0; page < BEHAVIOR_SESSION_LOOKUP_PAGES; page += 1) {
    const response: UsageDetailsEnvelope = await invoke<UsageDetailsEnvelope>('get_usage_details', {
      query: { scope: 'local', ...canonical, cursor, limit: 50 },
    });
    if (isUnavailableEnvelope(response)) return null;
    const match = response.items.find((item) => item.sessionId === session.id
      && item.tool === session.tool
      && Number.isSafeInteger(item.id)
      && item.id > 0);
    if (match) return { id: match.id, sessionId: match.sessionId, tool: match.tool };
    if (!response.hasMore || !response.nextCursor) return null;
    cursor = response.nextCursor;
  }
  return null;
}

export function behaviorSessionKey(session: BehaviorSessionRef): string {
  return `${session.tool}|${session.id}`;
}

function windowLabel(start: string, end: string): string {
  return start === end ? start : `${start} 至 ${end}`;
}

/**
 * Opens the existing per-turn analysis drawer for a behavior-ranking session.
 *
 * - `locatingKey`: the session whose record is being looked up.
 * - `record`: the record handed to `SessionAnalysisDrawer` once found.
 * - `failure`: why the drawer could not be opened, naming the session; cleared
 *   by the next attempt or a new analysed window.
 *
 * `analysed` is the analysed window of the shown result (null while there
 * is none). A new window, or unmount, invalidates an in-flight lookup, so a slow
 * reply never opens a drawer for a window the page has already left; a
 * refresh of the same window keeps it.
 */
export function useBehaviorSessionAnalysis(analysed: Pick<BehaviorAnalysedWindow, 'start' | 'end' | 'timezone'> | null) {
  const [record, setRecord] = useState<SessionAnalysisRecord | null>(null);
  const [locatingKey, setLocatingKey] = useState<string | null>(null);
  const [failure, setFailure] = useState('');
  const generation = useRef(0);
  const start = analysed?.start ?? null;
  const end = analysed?.end ?? null;
  const timezone = analysed?.timezone ?? null;

  // A changed analysis window makes the record invalid. Run before paint so
  // the old drawer never briefly represents the newly selected window.
  useLayoutEffect(() => {
    generation.current += 1;
    setRecord(null);
    setLocatingKey(null);
    setFailure('');
  }, [start, end, timezone]);

  useEffect(() => () => { generation.current += 1; }, []);

  const open = useCallback(async (session: BehaviorSessionRef) => {
    if (start === null || end === null || timezone === null) return;
    const id = ++generation.current;
    setLocatingKey(behaviorSessionKey(session));
    setFailure('');
    try {
      const found = await findBehaviorSessionRecord(session, { start, end, timezone });
      if (id !== generation.current) return;
      if (found) setRecord(found);
      else setFailure(`本次分析的区间（${windowLabel(start, end)}）内已找不到会话 ${session.id} 的明细记录，可能已被清理，暂时无法逐轮分析。`);
    } catch {
      if (id === generation.current) setFailure(`暂时无法读取本机明细来定位会话 ${session.id}，请稍后重试。`);
    } finally {
      if (id === generation.current) setLocatingKey(null);
    }
  }, [end, start, timezone]);

  const close = useCallback(() => setRecord(null), []);

  return { record, locatingKey, failure, open, close };
}
