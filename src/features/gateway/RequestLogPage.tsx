import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Radio, RefreshCw, ScrollText, Search } from 'lucide-react';
import type { ToastType } from '../../types';
import { EmptyState } from '../../components/EmptyState';
import { InfoTip } from '../../components/InfoTip';
import { contextComposition } from '../../utils/contextComposition';
import { formatEstimatedUsd, formatTokens } from '../../utils/format';
import { t, useLang } from '../../i18n';
import { errorText, exportRequestLog, requestLog } from './api';
import { DecisionTrace } from './DecisionTrace';
import { HealthBadge, useProviderHealth } from './ProviderHealth';
import { ATTEMPT_OUTCOME_LABEL, DECISION_REASON_LABEL, effectiveTokens, requestLogSessionRef, shortTime, traceHeadline } from './helpers';
import { openSessionDetail } from '../sessionDetail/sessionDetailRoute';
import type { ProviderHealth, RequestLogAttempt, RequestLogEntry, RequestLogPage as LogPage, RequestLogQuery } from './types';
import { ContentSampleSection } from './ContentSampleSection';
import { ContentSamplingPanel, useContentSamplingStatus, type SamplingController } from './ContentSamplingPanel';
import './requestLog.css';

const PAGE_SIZE = 50;
/** 实时尾随的轮询间隔；窗口隐藏时跳过。 */
export const TAIL_INTERVAL_MS = 2000;
const SEARCH_DEBOUNCE_MS = 300;

type RangeId = '1h' | '24h' | '7d' | 'all';
const RANGES: { id: RangeId; readonly label: string; hours: number | null }[] = [
  { id: '1h', get label() { return t('requestLog.range.1h'); }, hours: 1 },
  { id: '24h', get label() { return t('requestLog.range.24h'); }, hours: 24 },
  { id: '7d', get label() { return t('requestLog.range.7d'); }, hours: 24 * 7 },
  { id: 'all', get label() { return t('requestLog.range.all'); }, hours: null },
];

const STATUS_OPTIONS: { value: string; readonly label: string }[] = [
  { value: '', get label() { return t('requestLog.status.all'); } },
  { value: 'ok', get label() { return t('requestLog.status.ok'); } },
  { value: 'error', get label() { return t('requestLog.status.error'); } },
  { value: 'retried', get label() { return t('requestLog.status.retried'); } },
  { value: '4xx', label: '4xx' },
  { value: '429', get label() { return t('requestLog.status.429'); } },
  { value: '5xx', label: '5xx' },
];

const LATENCY_OPTIONS: { value: string; readonly label: string; min?: number; max?: number }[] = [
  { value: '', get label() { return t('requestLog.latency.all'); } },
  { value: 'lt2', get label() { return t('requestLog.latency.under', { seconds: 2 }); }, max: 2000 },
  { value: 'gt10', get label() { return t('requestLog.latency.over', { seconds: 10 }); }, min: 10_000 },
  { value: 'gt30', get label() { return t('requestLog.latency.over', { seconds: 30 }); }, min: 30_000 },
  { value: 'gt60', get label() { return t('requestLog.latency.over', { seconds: 60 }); }, min: 60_000 },
];

export interface LogFilters {
  range: RangeId;
  agent: string;
  provider: string;
  model: string;
  status: string;
  latency: string;
  search: string;
}

const EMPTY_FILTERS: LogFilters = { range: '24h', agent: '', provider: '', model: '', status: '', latency: '', search: '' };

/** 界面筛选 → 后端查询。`now` 由调用方给，便于测试。 */
export function toQuery(filters: LogFilters, offset: number, now: number = Date.now()): RequestLogQuery {
  const hours = RANGES.find((range) => range.id === filters.range)?.hours ?? null;
  const latency = LATENCY_OPTIONS.find((option) => option.value === filters.latency);
  return {
    since: hours == null ? null : new Date(now - hours * 3_600_000).toISOString(),
    agent: filters.agent || null,
    provider: filters.provider || null,
    model: filters.model || null,
    status: filters.status || null,
    minLatencyMs: latency?.min ?? null,
    maxLatencyMs: latency?.max ?? null,
    search: filters.search.trim() || null,
    offset,
    limit: PAGE_SIZE,
  };
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function formatTps(tps: number | null | undefined): string {
  if (tps == null || !Number.isFinite(tps) || tps <= 0) return '—';
  return `${tps < 10 ? tps.toFixed(1) : Math.round(tps)} tok/s`;
}

function memberOf(attempt: RequestLogAttempt): string {
  return attempt.member ?? `${attempt.provider}/${attempt.upstreamModel}`;
}

/** 一句话：组请求先说解释链里的问题或排位原因，直连请求说切换次数。 */
function routeSummary(entry: RequestLogEntry): string | null {
  const last = entry.attempts[entry.attempts.length - 1];
  const trace = entry.decision?.trace?.find((item) => last && item.member === memberOf(last));
  const headline = trace ? traceHeadline(trace.reasons) : null;
  if (headline) return headline;
  if (entry.decision) return DECISION_REASON_LABEL[entry.decision.reason] ?? entry.decision.reason;
  return null;
}

function attemptOutcome(attempt: RequestLogAttempt, index: number, count: number): string {
  if (attempt.ok) return ATTEMPT_OUTCOME_LABEL.ok ?? t('requestLog.status.ok');
  // 供应商已删除或停用：网关没有发出请求，后端按路由决策补的零用量尝试。
  if (attempt.requestId.startsWith('skipped:')) return ATTEMPT_OUTCOME_LABEL.skipped ?? t('requestLog.attempt.skipped');
  return index < count - 1 ? (ATTEMPT_OUTCOME_LABEL.failed ?? t('requestLog.attempt.failed')) : (ATTEMPT_OUTCOME_LABEL.rejected ?? t('requestLog.attempt.rejected'));
}

function ContextBars({ entry }: { entry: RequestLogEntry }) {
  const segments = contextComposition(entry.context ?? undefined, entry.input + entry.cacheRead + entry.cacheWrite);
  if (!segments) return <p className="mw-caption">{t('requestLog.context.none')}</p>;
  return (
    <div className="mw-log-context">
      <div className="mw-log-context-bar" aria-hidden="true">
        {segments.map((segment) => (
          <span key={segment.key} className={`mw-log-seg is-${segment.key}`} style={{ width: `${Math.max(segment.share * 100, 1)}%` }} />
        ))}
      </div>
      <ul className="mw-log-context-legend" aria-label={t('requestLog.section.context')}>
        {segments.map((segment) => (
          <li key={segment.key}>
            <span className={`mw-log-dot is-${segment.key}`} aria-hidden="true" />
            {segment.label} {Math.round(segment.share * 100)}%
            {segment.estimatedTokens != null && <span className="mw-faint"> · {t('requestLog.context.approx', { tokens: formatTokens(segment.estimatedTokens) })}</span>}
          </li>
        ))}
      </ul>
      {entry.context && (
        <p className="mw-caption">{t('requestLog.context.counts', { messages: entry.context.messages, toolResults: entry.context.toolResults, attachments: entry.context.attachments })}</p>
      )}
    </div>
  );
}

function EntryDetail({ entry, health, sampling }: { entry: RequestLogEntry; health: Map<string, ProviderHealth>; sampling: SamplingController }) {
  const hasSample = sampling.status?.sampleIds.includes(entry.id) ?? false;
  const sessionRef = requestLogSessionRef(entry);
  return (
    <div className="mw-log-detail">
      <section aria-label={t('requestLog.section.attempts')}>
        <h3>{t('requestLog.section.attempts')}{entry.retries > 0 && <span className="mw-faint"> · {t(entry.switched ? 'requestLog.attempts.retriedSwitched' : 'requestLog.attempts.retried', { count: entry.retries })}</span>}</h3>
        <ol className="mw-log-attempts">
          {entry.attempts.map((attempt, index) => (
            <li key={attempt.requestId} className={attempt.ok ? 'is-ok' : 'is-failed'}>
              <span className="mw-log-attempt-rank" aria-hidden="true">{index + 1}</span>
              <span className="mw-mono-text mw-log-attempt-member">{memberOf(attempt)}<HealthBadge compact health={health.get(attempt.provider)} /></span>
              <span className={`mw-chip ${attempt.ok ? 'is-success' : 'is-warning'}`}>{attempt.status} · {attemptOutcome(attempt, index, entry.attempts.length)}</span>
              <span className="mw-log-attempt-meta">
                {t('requestLog.attempt.latency', { value: formatMs(attempt.latencyMs) })}
                {attempt.firstTokenMs != null && <> · {t('requestLog.attempt.firstToken', { value: formatMs(attempt.firstTokenMs) })}</>}
                {' · '}{formatTokens(effectiveTokens(attempt))} Token · {formatEstimatedUsd(attempt.costUsd, 'record')}
              </span>
              {attempt.error && <span className="mw-log-attempt-error" title={attempt.error}>{attempt.error}</span>}
            </li>
          ))}
        </ol>
      </section>
      {entry.decision && (
        <section aria-label={t('requestLog.section.trace')}>
          <h3>{t('requestLog.section.why')}<span className="mw-faint"> · group/{entry.decision.group} · {DECISION_REASON_LABEL[entry.decision.reason] ?? entry.decision.reason}</span></h3>
          {entry.decision.detail && <p className="mw-caption">{entry.decision.detail}</p>}
          <DecisionTrace decision={entry.decision} />
        </section>
      )}
      <section aria-label={t('requestLog.section.usage')}>
        <h3>{t('requestLog.section.usage')}</h3>
        <dl className="mw-log-facts">
          <div><dt>{t('requestLog.fact.input')}</dt><dd>{formatTokens(entry.input)}</dd></div>
          <div><dt>{t('requestLog.fact.output')}</dt><dd>{formatTokens(entry.output)}</dd></div>
          <div><dt>{t('requestLog.fact.cacheRead')}</dt><dd>{formatTokens(entry.cacheRead)}</dd></div>
          <div><dt>{t('requestLog.fact.cacheWrite')}</dt><dd>{formatTokens(entry.cacheWrite)}</dd></div>
          <div><dt>{t('requestLog.fact.cost')}</dt><dd>{formatEstimatedUsd(entry.costUsd, 'record')}</dd></div>
          <div><dt>{t('requestLog.fact.firstToken')}</dt><dd>{formatMs(entry.firstTokenMs)}</dd></div>
          <div><dt>{t('requestLog.fact.speed')}</dt><dd>{formatTps(entry.outputTps)}</dd></div>
          <div><dt>{t('requestLog.fact.latency')}</dt><dd>{formatMs(entry.latencyMs)}</dd></div>
        </dl>
      </section>
      <section aria-label={t('requestLog.section.context')}>
        <h3>{t('requestLog.section.context')}</h3>
        <ContextBars entry={entry} />
      </section>
      <section aria-label={t('requestLog.section.request')}>
        <h3>{t('requestLog.section.request')}</h3>
        <dl className="mw-log-facts is-wide">
          <div><dt>{t('requestLog.fact.id')}</dt><dd className="mw-mono-text">{entry.id}</dd></div>
          <div>
            <dt>{t('requestLog.fact.session')}</dt>
            <dd>
              <span className="mw-mono-text">{entry.session ?? '—'}</span>
              {sessionRef && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="secondary-inline"
                    aria-label={t('sessionDetail.openAria', { id: sessionRef.sessionId })}
                    onClick={() => openSessionDetail(sessionRef)}
                  >
                    {t('sessionDetail.open')}
                  </button>
                  {' '}
                  <span className="mw-caption">{t('sessionDetail.fullHistoryHint')}</span>
                </>
              )}
            </dd>
          </div>
          <div><dt>{t('requestLog.fact.endpoint')}</dt><dd>{entry.endpoint}{entry.stream ? ` · ${t('requestLog.fact.stream')}` : ''} → {entry.wire}</dd></div>
          <div><dt>{t('requestLog.fact.started')}</dt><dd>{new Date(entry.startedAt).toLocaleString()}</dd></div>
        </dl>
      </section>
      {hasSample && <ContentSampleSection id={entry.id} />}
    </div>
  );
}

export function RequestLogPage({ onNotify }: { onNotify?: (type: ToastType, text: string) => void }) {
  // Subscribing re-renders the page when the language changes.
  useLang();
  // 尝试行旁显示该供应商当前（近 24 小时）的健康度，便于判断失败是偶发还是持续。
  const health = useProviderHealth();
  const contentSampling = useContentSamplingStatus();
  const [filters, setFilters] = useState<LogFilters>(EMPTY_FILTERS);
  const [searchText, setSearchText] = useState('');
  const [offset, setOffset] = useState(0);
  const [tail, setTail] = useState(false);
  const [page, setPage] = useState<LogPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const seen = useRef<Set<string>>(new Set());
  // Only the latest load may apply its result: an older, slower query must not
  // overwrite the page after the filters changed.
  const generation = useRef(0);
  // 尾随轮询时上一次读取还没回来就跳过这一拍，避免慢读取被不断作废。
  const inFlight = useRef(false);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((current) => (current.search === searchText ? current : { ...current, search: searchText }));
      setOffset(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchText]);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    inFlight.current = true;
    setLoading(true);
    try {
      const next = await requestLog(toQuery(filters, offset));
      if (mine !== generation.current) return;
      // 刷新后匹配条数变少、当前页已越界：退到最后一页重新读取。
      if (next.total > 0 && offset >= next.total) {
        setOffset(Math.floor((next.total - 1) / PAGE_SIZE) * PAGE_SIZE);
        return;
      }
      // 尾随时新到的行短暂高亮；首次加载不算新。
      const ids = next.entries.map((entry) => entry.id);
      const arrived = seen.current.size === 0 ? new Set<string>() : new Set(ids.filter((id) => !seen.current.has(id)));
      ids.forEach((id) => seen.current.add(id));
      setFresh(arrived);
      setPage(next);
      setError(null);
    } catch (reason) {
      if (mine === generation.current) setError(errorText(reason));
    } finally {
      if (mine === generation.current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, [filters, offset]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!tail) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden' || inFlight.current) return;
      void load();
    }, TAIL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [tail, load]);

  const update = (patch: Partial<LogFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setOffset(0);
  };

  const toggleTail = () => {
    setTail((value) => !value);
    setOffset(0);
  };

  const runExport = async () => {
    setExporting(true);
    try {
      const { offset: _offset, limit: _limit, ...query } = toQuery(filters, 0);
      const result = await exportRequestLog(query);
      onNotify?.('success', t('requestLog.exported', { message: result.message, path: result.path }));
    } catch (reason) {
      onNotify?.('error', errorText(reason));
    } finally {
      setExporting(false);
    }
  };

  const facets = page?.facets ?? { agents: [], providers: [], models: [] };
  const filtered = useMemo(() => Object.entries(filters).some(([key, value]) => key !== 'range' && value !== ''), [filters]);
  const total = page?.total ?? 0;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  const toggleEntry = (id: string) => {
    const next = open === id ? null : id;
    setOpen(next);
    if (next) void contentSampling.refresh();
  };

  return (
    <div className="mw-page-stack mw-log-page">
      <div className="mw-card mw-panel">
        <div className="mw-log-toolbar" role="search" aria-label={t('requestLog.filter.aria')}>
          <div className="mw-seg is-sm" role="radiogroup" aria-label={t('requestLog.filter.range')}>
            {RANGES.map((range) => (
              <button key={range.id} type="button" role="radio" aria-checked={filters.range === range.id} className={filters.range === range.id ? 'is-on' : ''} onClick={() => update({ range: range.id })}>{range.label}</button>
            ))}
          </div>
          <select className="mw-native-select is-compact" aria-label={t('requestLog.filter.agent')} value={filters.agent} onChange={(event) => update({ agent: event.target.value })}>
            <option value="">{t('requestLog.filter.agentAll')}</option>
            {facets.agents.map((agent) => <option key={agent} value={agent}>{agent}</option>)}
          </select>
          <select className="mw-native-select is-compact" aria-label={t('requestLog.filter.provider')} value={filters.provider} onChange={(event) => update({ provider: event.target.value })}>
            <option value="">{t('requestLog.filter.providerAll')}</option>
            {facets.providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
          </select>
          <select className="mw-native-select is-compact" aria-label={t('requestLog.filter.model')} value={filters.model} onChange={(event) => update({ model: event.target.value })}>
            <option value="">{t('requestLog.filter.modelAll')}</option>
            {facets.models.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
          <select className="mw-native-select is-compact" aria-label={t('requestLog.filter.status')} value={filters.status} onChange={(event) => update({ status: event.target.value })}>
            {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <select className="mw-native-select is-compact" aria-label={t('requestLog.filter.latency')} value={filters.latency} onChange={(event) => update({ latency: event.target.value })}>
            {LATENCY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <label className="mw-search is-inline mw-log-search">
            <Search className="h-4 w-4" aria-hidden="true" />
            <input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder={t('requestLog.search.placeholder')} aria-label={t('requestLog.search.aria')} />
          </label>
          <div className="mw-log-actions">
            <button type="button" className={`mw-btn ${tail ? 'is-primary' : 'is-ghost'}`} aria-pressed={tail} onClick={toggleTail}>
              <Radio className={`h-3.5 w-3.5 ${tail ? 'mw-log-live' : ''}`} aria-hidden="true" />{tail ? t('requestLog.tail.on') : t('requestLog.tail.off')}
            </button>
            <button type="button" className="mw-btn is-ghost" onClick={() => void load()} disabled={loading}><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />{t('requestLog.refresh')}</button>
            <button type="button" className="mw-btn is-ghost" onClick={() => void runExport()} disabled={exporting || total === 0}><Download className="h-3.5 w-3.5" aria-hidden="true" />{exporting ? t('requestLog.exporting') : t('requestLog.export')}</button>
          </div>
        </div>
        <p className="mw-caption mw-log-summary" aria-live="polite">
          {page ? <>{t('requestLog.summary.matched', { total })}{total > 0 && <>{t('requestLog.summary.showing', { from: offset + 1, to: pageEnd })}</>} · {t('requestLog.summary.retained', { count: page.retained })}{page.oldest && <>{t('requestLog.summary.oldest', { time: shortTime(page.oldest) })}</>}</> : t('requestLog.loading')}
          <InfoTip label={t('requestLog.info.label')}>{t('requestLog.info.body')}</InfoTip>
        </p>
        {error && <p className="mw-caption is-danger" role="alert">{error}</p>}
        <ContentSamplingPanel compact controller={contentSampling} onNotify={onNotify} />
        {page && page.retained === 0 ? (
          <EmptyState variant="inset" icon={ScrollText} title={t('requestLog.empty.title')} description={t('requestLog.empty.body')} />
        ) : page && total === 0 ? (
          <EmptyState variant="inset" icon={Search} title={t('requestLog.noMatch.title')} description={filtered ? t('requestLog.noMatch.filtered') : t('requestLog.noMatch.range')}>
            {filtered && <button type="button" className="secondary-inline" onClick={() => { setSearchText(''); setFilters({ ...EMPTY_FILTERS, range: filters.range }); setOffset(0); }}>{t('requestLog.clearFilters')}</button>}
          </EmptyState>
        ) : (
          <div className="mw-table-wrap">
            <table className="mw-table mw-log-table" aria-label={t('requestLog.table.aria')}>
              <thead>
                <tr>
                  <th>{t('requestLog.col.time')}</th><th>Agent</th><th>{t('requestLog.filter.model')}</th><th>{t('requestLog.col.routed')}</th><th>{t('requestLog.filter.status')}</th>
                  <th className="is-num">{t('requestLog.col.tokens')}</th><th className="is-num">{t('requestLog.col.cost')}</th><th className="is-num">{t('requestLog.col.firstToken')}</th><th className="is-num">{t('requestLog.filter.latency')}</th><th className="is-num">{t('requestLog.fact.speed')}</th>
                </tr>
              </thead>
              <tbody>
                {page?.entries.map((entry) => {
                  const expanded = open === entry.id;
                  const why = routeSummary(entry);
                  return (
                    <Fragment key={entry.id}>
                      <tr className={`mw-log-row${fresh.has(entry.id) ? ' is-fresh' : ''}${expanded ? ' is-open' : ''}`}>
                        <td>
                          <button type="button" className="mw-log-toggle" aria-expanded={expanded} aria-label={t(expanded ? 'requestLog.row.collapse' : 'requestLog.row.expand', { time: shortTime(entry.ts) })} onClick={() => toggleEntry(entry.id)}>
                            {shortTime(entry.ts)}
                          </button>
                        </td>
                        <td>{entry.agent ?? '—'}</td>
                        <td className="mw-mono-text">{entry.requestedModel}</td>
                        <td className="mw-mono-text">
                          {entry.provider}/{entry.upstreamModel}
                          {entry.retries > 0 && <span className="mw-chip is-warning mw-log-inline-chip">{t(entry.switched ? 'requestLog.row.switched' : 'requestLog.row.retried', { count: entry.retries })}</span>}
                          {why && <span className="mw-chip is-info mw-log-inline-chip">{why}</span>}
                        </td>
                        <td className={entry.ok ? '' : 'is-danger'} title={entry.error ?? undefined}>{entry.status}</td>
                        <td className="is-num">{formatTokens(effectiveTokens(entry))}</td>
                        <td className="is-num">{formatEstimatedUsd(entry.costUsd, 'record')}</td>
                        <td className="is-num">{formatMs(entry.firstTokenMs)}</td>
                        <td className="is-num">{formatMs(entry.latencyMs)}</td>
                        <td className="is-num">{formatTps(entry.outputTps)}</td>
                      </tr>
                      {expanded && (
                        <tr className="mw-log-detail-row">
                          <td colSpan={10}><EntryDetail entry={entry} health={health} sampling={contentSampling} /></td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {total > PAGE_SIZE && (
          <div className="mw-log-pager">
            <button type="button" className="mw-btn is-ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>{t('requestLog.page.prev')}</button>
            <span className="mw-caption">{Math.floor(offset / PAGE_SIZE) + 1} / {Math.ceil(total / PAGE_SIZE)}</span>
            <button type="button" className="mw-btn is-ghost" disabled={pageEnd >= total} onClick={() => { setTail(false); setOffset(offset + PAGE_SIZE); }}>{t('requestLog.page.next')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default RequestLogPage;
