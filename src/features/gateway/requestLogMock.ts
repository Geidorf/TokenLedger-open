// Browser dev preview of `gateway_request_log`: the same grouping, filters and
// paging as src-tauri/src/gateway/request_log.rs over the mock ledger. Costs
// use flat illustrative rates; the real command prices with the local table.
import type { LedgerRecord, RequestLogAttempt, RequestLogEntry, RequestLogPage, RequestLogQuery, RouteDecision } from './types';

const MOCK_RATES = { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.5625 };

function costOf(record: Pick<LedgerRecord, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>): number {
  return (record.input * MOCK_RATES.input + record.output * MOCK_RATES.output
    + record.cacheRead * MOCK_RATES.cacheRead + record.cacheWrite * MOCK_RATES.cacheWrite) / 1_000_000;
}

function attemptOf(record: LedgerRecord): RequestLogAttempt {
  return {
    ts: record.ts, requestId: record.requestId, provider: record.provider, upstreamModel: record.upstreamModel,
    member: record.member ?? null, status: record.status, ok: record.ok, latencyMs: record.latencyMs,
    firstTokenMs: record.firstTokenMs ?? null, input: record.input, output: record.output,
    cacheRead: record.cacheRead, cacheWrite: record.cacheWrite, error: record.error ?? null, costUsd: costOf(record),
  };
}

/** `records` in any order; attempts of one logical request are ordered by time. */
export function groupRecords(records: LedgerRecord[], decisions: RouteDecision[]): RequestLogEntry[] {
  const byId = new Map<string, LedgerRecord[]>();
  for (const record of [...records].sort((a, b) => a.ts.localeCompare(b.ts))) {
    const id = record.logicalRequestId ?? record.requestId;
    byId.set(id, [...(byId.get(id) ?? []), record]);
  }
  const decisionById = new Map(decisions.map((decision) => [decision.requestId, decision]));
  const entries = [...byId.entries()].map(([id, attempts]): RequestLogEntry => {
    const first = attempts[0];
    const last = attempts[attempts.length - 1];
    const start = Date.parse(first.ts) - first.latencyMs;
    const latencyMs = Math.max(0, Date.parse(last.ts) - start);
    const offset = Math.max(0, latencyMs - last.latencyMs);
    const generating = last.firstTokenMs != null && last.latencyMs > last.firstTokenMs ? last.latencyMs - last.firstTokenMs : last.latencyMs;
    const sum = (key: 'input' | 'output' | 'cacheRead' | 'cacheWrite') => attempts.reduce((total, a) => total + a[key], 0);
    const views = attempts.map(attemptOf);
    return {
      id, startedAt: new Date(start).toISOString(), ts: last.ts, agent: first.agent ?? null, session: first.session ?? null,
      endpoint: first.endpoint, wire: last.wire, stream: first.stream, requestedModel: first.requestedModel, group: first.group ?? null,
      provider: last.provider, upstreamModel: last.upstreamModel, status: last.status, ok: last.ok, error: last.error ?? null,
      latencyMs, firstTokenMs: last.firstTokenMs != null ? offset + last.firstTokenMs : null,
      outputTps: last.output > 0 && generating > 0 ? (last.output * 1000) / generating : null,
      input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'),
      costUsd: views.reduce((total, a) => total + (a.costUsd ?? 0), 0),
      context: attempts.find((a) => a.context)?.context ?? null,
      retries: attempts.length - 1,
      switched: new Set(attempts.map((a) => `${a.provider}/${a.upstreamModel}`)).size > 1,
      attempts: views,
      decision: decisionById.get(id) ?? null,
    };
  });
  return entries.sort((a, b) => b.ts.localeCompare(a.ts));
}

function statusMatches(entry: RequestLogEntry, wanted: string): boolean {
  switch (wanted) {
    case 'ok': return entry.ok;
    case 'error': return !entry.ok;
    case '4xx': return entry.status >= 400 && entry.status < 500;
    case '5xx': return entry.status >= 500 && entry.status < 600;
    case 'retried': return entry.retries > 0;
    default: return String(entry.status) === wanted;
  }
}

export function matches(entry: RequestLogEntry, query: RequestLogQuery): boolean {
  const ts = Date.parse(entry.ts);
  if (query.since && ts < Date.parse(query.since)) return false;
  if (query.until && ts > Date.parse(query.until)) return false;
  if (query.agent && (entry.agent ?? '') !== query.agent) return false;
  if (query.provider && !entry.attempts.some((a) => a.provider === query.provider)) return false;
  if (query.model && entry.requestedModel !== query.model && !entry.attempts.some((a) => a.upstreamModel === query.model || `${a.provider}/${a.upstreamModel}` === query.model)) return false;
  if (query.status && !statusMatches(entry, query.status)) return false;
  if (query.minLatencyMs != null && entry.latencyMs < query.minLatencyMs) return false;
  if (query.maxLatencyMs != null && entry.latencyMs > query.maxLatencyMs) return false;
  const needle = query.search?.trim().toLowerCase();
  if (needle) {
    const fields = [entry.id, entry.agent, entry.session, entry.requestedModel, entry.upstreamModel, entry.provider, entry.group, entry.error, entry.endpoint,
      ...entry.attempts.flatMap((a) => [a.requestId, a.provider, a.upstreamModel, a.error])];
    if (!fields.some((field) => field?.toLowerCase().includes(needle))) return false;
  }
  return true;
}

export function mockRequestLog(records: LedgerRecord[], decisions: RouteDecision[], query: RequestLogQuery): RequestLogPage {
  const entries = groupRecords(records, decisions);
  const agents = new Set<string>();
  const providers = new Set<string>();
  const models = new Set<string>();
  for (const entry of entries) {
    if (entry.agent) agents.add(entry.agent);
    for (const attempt of entry.attempts) {
      providers.add(attempt.provider);
      models.add(`${attempt.provider}/${attempt.upstreamModel}`);
    }
    if (entry.group) models.add(entry.requestedModel);
  }
  const matching = entries.filter((entry) => matches(entry, query));
  const offset = Math.min(query.offset ?? 0, matching.length);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  return {
    entries: matching.slice(offset, offset + limit),
    total: matching.length,
    offset,
    retained: entries.length,
    oldest: entries[entries.length - 1]?.startedAt ?? null,
    facets: { agents: [...agents].sort(), providers: [...providers].sort(), models: [...models].sort() },
  };
}
