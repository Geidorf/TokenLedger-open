import { describe, expect, it } from 'vitest';
import { behaviorAnalysisForQuery, mockBehaviorLedger, mockRequestSizeBins } from '../devMockTauri';
import type { BehaviorAnalysisResponse, LogHistoryItem } from '../types';

// The browser preview mock must follow the native aggregation (commands/mod.rs)
// so preview screenshots stay representative. Like the dashboard mock, its
// ledger is written in host wall-clock time: the clock is fixed at 2026-07-15
// 14:30 host time (a Wednesday) and the rows span the latest 90 host days. The
// behavior mock reads every date and hour in the selected zone, so calendar
// expectations select the host zone and hold in any TZ; the selected-zone case
// derives its expectations from the same instants instead.
const HOST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const MOCK_NOW = new Date(2026, 6, 15, 14, 30, 0, 0);

function analyse(query: Record<string, unknown>, ledger?: LogHistoryItem[]): BehaviorAnalysisResponse {
  return behaviorAnalysisForQuery({ timezone: HOST_ZONE, ...query }, ledger) as BehaviorAnalysisResponse;
}

/** Host wall time `YYYY-MM-DD HH:MM:SS` (as the host-zone analysis reports it) -> instant. */
function hostInstant(wall: string): Date {
  const [year, month, day, hour, minute, second] = wall.split(/[- :]/).map(Number);
  return new Date(year, month - 1, day, hour, minute, second);
}

/** Independent oracle: an instant as `YYYY-MM-DD HH:MM:SS` wall time in `timeZone`. */
function wallIn(timeZone: string, value: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(value);
}

const byteOrder = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Host calendar day of a stored ledger timestamp. */
const hostDay = (timestamp: string) => wallIn(HOST_ZONE, new Date(timestamp)).slice(0, 10);

// `all` covers the latest 731 host days: 2024-07-15 through the mock "now".
const ALL_WINDOW_START = '2024-07-15';

/**
 * Oracle for the `all` window, derived from the ledger itself so the
 * expectations follow the mock data (other tasks add mock sources) instead of
 * pinning its size.
 */
function allWindowRows(ledger: LogHistoryItem[]): LogHistoryItem[] {
  return ledger.filter((row) => Date.parse(row.timestamp) <= MOCK_NOW.getTime() && hostDay(row.timestamp) >= ALL_WINDOW_START);
}

describe('dev mock behavior analysis parity with Rust', () => {
  it('bins record sizes exactly like build_request_size_bins', () => {
    const bins = mockRequestSizeBins([100, 1200, 15_000, 420_000]);
    expect(bins).toHaveLength(31);
    expect(bins[0]).toEqual({ lower: 0, upper: 14_000, requests: 2 });
    expect(bins[1]).toEqual({ lower: 14_000, upper: 28_000, requests: 1 });
    expect(bins[30]).toEqual({ lower: 420_000, upper: 434_000, requests: 1 });
    expect(mockRequestSizeBins([0, 999, 1000])).toEqual([
      { lower: 0, upper: 1000, requests: 2 },
      { lower: 1000, upper: 2000, requests: 1 },
    ]);
    expect(mockRequestSizeBins([])).toEqual([{ lower: 0, upper: 1000, requests: 0 }]);
  });

  it('orders the record-size models by records, then by name, and keeps every record in a bin', () => {
    const result = analyse({ range: 'month' });
    const order = result.requestSizes.map(({ model, requests }) => ({ model, requests }));
    expect(order).toEqual([...order].sort((a, b) => b.requests - a.requests || byteOrder(a.model, b.model)));
    for (const entry of result.requestSizes) {
      expect(entry.bins.length).toBeLessThanOrEqual(32);
      expect(entry.bins[0].lower).toBe(0);
      expect((entry.bins[0].upper - entry.bins[0].lower) % 1000).toBe(0);
      expect(entry.bins.reduce((sum, bin) => sum + bin.requests, 0)).toBe(entry.requests);
    }
    const sessionOrder = result.sessions.map(({ tokens, tool, id }) => ({ tokens, tool, id }));
    expect(sessionOrder).toEqual([...sessionOrder].sort((a, b) => b.tokens - a.tokens || byteOrder(a.tool, b.tool) || byteOrder(a.id, b.id)));
  });

  it('uses calendar preset windows, ignores preset bounds and reports wall-clock record times', () => {
    const week = analyse({ range: 'week', start: '2020-01-01', end: '2020-01-07' });
    expect([week.meta.start, week.meta.end]).toEqual(['2026-07-13', '2026-07-15']);
    const month = analyse({ range: 'month' });
    expect([month.meta.start, month.meta.end]).toEqual(['2026-07-01', '2026-07-15']);
    expect(month.meta.firstRecordAt).toMatch(/^2026-07-01 \d{2}:\d{2}:\d{2}$/);
    expect(month.meta.lastRecordAt).toMatch(/^2026-07-15 \d{2}:\d{2}:\d{2}$/);
    expect(month.meta.rangeTruncated).toBe(false);
  });

  it('caps all to 731 local days and starts at the oldest record when nothing is cut', () => {
    const ledger = mockBehaviorLedger('default');
    const all = analyse({ range: 'all' });
    expect(all.meta.rangeDayLimit).toBe(731);
    expect(all.meta.rangeTruncated).toBe(false);
    const oldest = ledger.reduce((first, row) => (Date.parse(row.timestamp) < Date.parse(first.timestamp) ? row : first));
    expect([all.meta.start, all.meta.end]).toEqual([hostDay(oldest.timestamp), '2026-07-15']);
    // Nothing in the default ledger is older than the window, so every row up to "now" counts.
    const upToNow = ledger.filter((row) => Date.parse(row.timestamp) <= MOCK_NOW.getTime());
    expect(allWindowRows(ledger)).toHaveLength(upToNow.length);
    expect(all.meta.recordCount).toBe(upToNow.length);
    expect(all.meta.recordCount).toBeGreaterThan(0);
  });

  it('keeps a custom end on or after a start that lies in the future', () => {
    const future = analyse({ range: 'custom', start: '2026-08-01', end: '2026-08-05' });
    expect([future.meta.start, future.meta.end]).toEqual(['2026-08-01', '2026-08-01']);
    expect(future.meta.recordCount).toBe(0);
  });

  it('adds session cost, wall-clock span and top model like the native aggregation', () => {
    const result = analyse({ range: 'week' });
    expect(result.summary.costComplete).toBe(true);
    let sessionCosts = 0;
    for (const session of result.sessions) {
      expect(typeof session.cost).toBe('number');
      sessionCosts += session.cost ?? Number.NaN;
      expect(session.firstAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(session.lastAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(session.firstAt! <= session.lastAt!).toBe(true);
      expect(result.requestSizes.map((entry) => entry.model)).toContain(session.topModel);
    }
    // Every mock row carries a real session ID, so the sessions hold the whole total.
    expect(result.summary.totalCost).toBeCloseTo(sessionCosts, 6);
  });

  it('counts only real session IDs as sessions', () => {
    const result = analyse({ range: 'week' });
    expect(result.summary.unknownSessionRecords).toBe(0);
    expect(result.summary.unknownSessionTokens).toBe(0);
    expect(result.summary.sessionCount).toBe(result.meta.recordCount);
    expect(result.tools.reduce((sum, tool) => sum + tool.sessionCount, 0)).toBe(result.summary.sessionCount);
    expect(result.tools.every((tool) => tool.unknownSessionRecords === 0)).toBe(true);
  });

  it('counts placeholder, empty and blank session IDs as unknown records of their tool', () => {
    const row = (id: number, tool: string, sessionId: string, hour: number): LogHistoryItem => ({
      id, tool, model: `${tool}-model`, inputTokens: 100 * id, outputTokens: 10 * id, cachedTokens: 0,
      cost: 0.01 * id, timestamp: new Date(2026, 6, 15, hour, 0, 0).toISOString(), sessionId, machineId: 'Studio-PC',
    });
    // Newest first, like the shared mock ledger.
    const ledger = [
      row(4, 'minimax', '   ', 12),
      row(3, 'minimax', '', 11),
      row(2, 'codex', 'unknown_session', 10),
      row(1, 'codex', 'real-session', 9),
    ];
    const result = analyse({ range: 'today' }, ledger);
    expect(result.meta.recordCount).toBe(4);
    expect(result.summary.sessionCount).toBe(1);
    expect(result.sessions.map((session) => session.id)).toEqual(['real-session']);
    expect(result.summary.unknownSessionRecords).toBe(3);
    // Effective tokens (input + output) of the three rows without a session.
    expect(result.summary.unknownSessionTokens).toBe(220 + 330 + 440);
    expect(result.tools).toEqual([
      { id: 'minimax', tokens: 770, requests: 2, sessionCount: 0, unknownSessionRecords: 2 },
      { id: 'codex', tokens: 330, requests: 2, sessionCount: 1, unknownSessionRecords: 1 },
    ]);
    // Every record is still costed, with or without a session.
    expect(result.summary.totalCost).toBeCloseTo(0.1, 10);
  });

  it('reads the same ledger instants in the selected timezone, not the host zone', () => {
    const host = analyse({ range: 'all' });
    const hostSessions = new Map(host.sessions.map((session) => [session.id, session]));
    for (const timeZone of ['Pacific/Kiritimati', 'America/Los_Angeles']) {
      const zoned = analyse({ range: 'all', timezone: timeZone });
      expect(zoned.meta.timezone).toBe(timeZone);
      expect(zoned.meta.recordCount).toBe(host.meta.recordCount);
      expect(zoned.meta.firstRecordAt).toBe(wallIn(timeZone, hostInstant(host.meta.firstRecordAt!)));
      expect(zoned.meta.lastRecordAt).toBe(wallIn(timeZone, hostInstant(host.meta.lastRecordAt!)));
      const buckets = new Set(zoned.dayHours.map((bucket) => `${bucket.date} ${bucket.hour}`));
      for (const session of zoned.sessions) {
        expect(session.firstAt).toBe(wallIn(timeZone, hostInstant(hostSessions.get(session.id)!.firstAt!)));
        // Each mock session is a single record, so its zoned hour has a bucket.
        expect(buckets.has(`${session.firstAt!.slice(0, 10)} ${Number(session.firstAt!.slice(11, 13))}`)).toBe(true);
      }

      // Presets follow the selected zone's calendar and "now".
      const zonedToday = wallIn(timeZone, MOCK_NOW).slice(0, 10);
      expect(zoned.meta.end).toBe(zonedToday);
      const today = analyse({ range: 'today', timezone: timeZone });
      expect([today.meta.start, today.meta.end]).toEqual([zonedToday, zonedToday]);
      expect(today.dayHours.every((bucket) => bucket.date === zonedToday)).toBe(true);
      const todayValue = Date.parse(`${zonedToday}T00:00:00Z`);
      const monday = new Date(todayValue - ((new Date(todayValue).getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
      expect(analyse({ range: 'week', timezone: timeZone }).meta.start).toBe(monday);
      const custom = analyse({ range: 'custom', start: '2026-07-10', end: '2026-07-12', timezone: timeZone });
      expect([custom.meta.start, custom.meta.end]).toEqual(['2026-07-10', '2026-07-12']);
      expect(custom.meta.recordCount).toBeGreaterThan(0);
      expect(custom.dayHours.every((bucket) => bucket.date >= '2026-07-10' && bucket.date <= '2026-07-12')).toBe(true);
    }
  });
});

// T10.164: the opt-in `?behaviorMock=edge` preview exercises the page's honesty
// states with the same aggregation rules as the default preview. Like the
// parity cases above it selects the host zone, so its calendar values hold in
// any TZ.
describe('dev mock behavior edge preview scenario', () => {
  function analyseEdge(query: Record<string, unknown>): BehaviorAnalysisResponse {
    return analyse(query, mockBehaviorLedger('edge'));
  }

  // This week in the host zone: Monday 07-13 up to the mock "now".
  const inWeek = (row: LogHistoryItem) => hostDay(row.timestamp) >= '2026-07-13' && Date.parse(row.timestamp) <= MOCK_NOW.getTime();

  it('keeps placeholder session IDs out of the sessions and counts them instead', () => {
    const minimaxRows = mockBehaviorLedger('edge').filter((row) => inWeek(row) && row.tool === 'minimax');
    expect(minimaxRows.length).toBeGreaterThan(0);
    const result = analyseEdge({ range: 'week' });
    expect(result.summary.unknownSessionRecords).toBe(minimaxRows.length);
    expect(result.summary.unknownSessionTokens).toBe(minimaxRows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0));
    expect(result.sessions.some((session) => session.tool === 'minimax')).toBe(false);
    // The whole source lacks session IDs: its session count is unknown, reported per tool.
    expect(result.tools.find((tool) => tool.id === 'minimax')).toMatchObject({
      requests: minimaxRows.length, sessionCount: 0, unknownSessionRecords: minimaxRows.length,
    });
    expect(result.tools.filter((tool) => tool.id !== 'minimax').every((tool) => tool.unknownSessionRecords === 0)).toBe(true);
    expect(result.summary.sessionCount + (result.summary.unknownSessionRecords ?? 0)).toBe(result.meta.recordCount);
  });

  it('reports an unavailable session cost and total as null, never as a partial sum', () => {
    const corrupt = mockBehaviorLedger('edge').filter((row) => Number.isNaN(row.cost));
    expect(corrupt).toHaveLength(1);
    expect(inWeek(corrupt[0])).toBe(true);
    const result = analyseEdge({ range: 'week' });
    const isCorrupt = (session: BehaviorAnalysisResponse['sessions'][number]) => session.id === corrupt[0].sessionId && session.tool === corrupt[0].tool;
    expect(result.sessions.find(isCorrupt)?.cost).toBeNull();
    expect(result.sessions.filter((session) => !isCorrupt(session)).every((session) => typeof session.cost === 'number')).toBe(true);
    expect(result.summary.totalCost).toBeNull();
    expect(result.summary.costComplete).toBe(false);
  });

  it('marks all as truncated at the 731-day window while the default preview is not', () => {
    const ledger = mockBehaviorLedger('edge');
    const all = analyseEdge({ range: 'all' });
    expect(all.meta.rangeTruncated).toBe(true);
    expect([all.meta.start, all.meta.end]).toEqual([ALL_WINDOW_START, '2026-07-15']);
    // Only the archived row falls before the window; the count follows the ledger, not a fixed size.
    expect(ledger.filter((row) => hostDay(row.timestamp) < ALL_WINDOW_START)).toHaveLength(1);
    expect(all.meta.recordCount).toBe(allWindowRows(ledger).length);
    const defaultAll = analyse({ range: 'all' });
    expect(all.meta.recordCount).toBe(defaultAll.meta.recordCount);
    expect(defaultAll.meta.rangeTruncated).toBe(false);
    expect(analyseEdge({ range: 'month' }).meta.rangeTruncated).toBe(false);
  });
});
