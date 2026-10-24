import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Radio, RefreshCw, ScrollText, Search } from 'lucide-react';
import type { ToastType } from '../../types';
import { EmptyState } from '../../components/EmptyState';
import { InfoTip } from '../../components/InfoTip';
import { contextComposition } from '../../utils/contextComposition';
import { formatEstimatedUsd, formatTokens } from '../../utils/format';
import { errorText, exportRequestLog, requestLog } from './api';
import { DecisionTrace } from './DecisionTrace';
import { ATTEMPT_OUTCOME_LABEL, DECISION_REASON_LABEL, effectiveTokens, shortTime, traceHeadline } from './helpers';
import type { RequestLogAttempt, RequestLogEntry, RequestLogPage as LogPage, RequestLogQuery } from './types';
import './requestLog.css';

const PAGE_SIZE = 50;
/** 实时尾随的轮询间隔；窗口隐藏时跳过。 */
export const TAIL_INTERVAL_MS = 2000;
const SEARCH_DEBOUNCE_MS = 300;

type RangeId = '1h' | '24h' | '7d' | 'all';
const RANGES: { id: RangeId; label: string; hours: number | null }[] = [
  { id: '1h', label: '1 小时', hours: 1 },
  { id: '24h', label: '24 小时', hours: 24 },
  { id: '7d', label: '7 天', hours: 24 * 7 },
  { id: 'all', label: '全部', hours: null },
];

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '全部状态' },
  { value: 'ok', label: '成功' },
  { value: 'error', label: '失败' },
  { value: 'retried', label: '有重试或切换' },
  { value: '4xx', label: '4xx' },
  { value: '429', label: '429 限流' },
  { value: '5xx', label: '5xx' },
];

const LATENCY_OPTIONS: { value: string; label: string; min?: number; max?: number }[] = [
  { value: '', label: '全部耗时' },
  { value: 'lt2', label: '2 秒内', max: 2000 },
  { value: 'gt10', label: '超过 10 秒', min: 10_000 },
  { value: 'gt30', label: '超过 30 秒', min: 30_000 },
  { value: 'gt60', label: '超过 60 秒', min: 60_000 },
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
  if (attempt.ok) return ATTEMPT_OUTCOME_LABEL.ok ?? '成功';
  // 供应商已删除或停用：网关没有发出请求，后端按路由决策补的零用量尝试。
  if (attempt.requestId.startsWith('skipped:')) return ATTEMPT_OUTCOME_LABEL.skipped ?? '跳过';
  return index < count - 1 ? (ATTEMPT_OUTCOME_LABEL.failed ?? '失败已切换') : (ATTEMPT_OUTCOME_LABEL.rejected ?? '上游拒绝');
}

function ContextBars({ entry }: { entry: RequestLogEntry }) {
  const segments = contextComposition(entry.context ?? undefined, entry.input + entry.cacheRead + entry.cacheWrite);
  if (!segments) return <p className="mw-caption">这条请求没有记录 Context 构成（旧版本记录或不支持的接口）。</p>;
  return (
    <div className="mw-log-context">
      <div className="mw-log-context-bar" aria-hidden="true">
        {segments.map((segment) => (
          <span key={segment.key} className={`mw-log-seg is-${segment.key}`} style={{ width: `${Math.max(segment.share * 100, 1)}%` }} />
        ))}
      </div>
      <ul className="mw-log-context-legend" aria-label="Context 构成">
        {segments.map((segment) => (
          <li key={segment.key}>
            <span className={`mw-log-dot is-${segment.key}`} aria-hidden="true" />
            {segment.label} {Math.round(segment.share * 100)}%
            {segment.estimatedTokens != null && <span className="mw-faint"> · 约 {formatTokens(segment.estimatedTokens)}</span>}
          </li>
        ))}
      </ul>
      {entry.context && (
        <p className="mw-caption">{entry.context.messages} 条消息 · {entry.context.toolResults} 个工具结果 · {entry.context.attachments} 个附件（Token 按字节占比估算）</p>
      )}
    </div>
  );
}

function EntryDetail({ entry }: { entry: RequestLogEntry }) {
  return (
    <div className="mw-log-detail">
      <section aria-label="尝试顺序">
        <h3>尝试顺序{entry.retries > 0 && <span className="mw-faint"> · 重试 {entry.retries} 次{entry.switched ? '，已切换' : ''}</span>}</h3>
        <ol className="mw-log-attempts">
          {entry.attempts.map((attempt, index) => (
            <li key={attempt.requestId} className={attempt.ok ? 'is-ok' : 'is-failed'}>
              <span className="mw-log-attempt-rank" aria-hidden="true">{index + 1}</span>
              <span className="mw-mono-text">{memberOf(attempt)}</span>
              <span className={`mw-chip ${attempt.ok ? 'is-success' : 'is-warning'}`}>{attempt.status} · {attemptOutcome(attempt, index, entry.attempts.length)}</span>
              <span className="mw-log-attempt-meta">
                耗时 {formatMs(attempt.latencyMs)}
                {attempt.firstTokenMs != null && <> · 首字 {formatMs(attempt.firstTokenMs)}</>}
                {' · '}{formatTokens(effectiveTokens(attempt))} Token · {formatEstimatedUsd(attempt.costUsd, 'record')}
              </span>
              {attempt.error && <span className="mw-log-attempt-error" title={attempt.error}>{attempt.error}</span>}
            </li>
          ))}
        </ol>
      </section>
      {entry.decision && (
        <section aria-label="路由决策解释链">
          <h3>为什么这样路由<span className="mw-faint"> · group/{entry.decision.group} · {DECISION_REASON_LABEL[entry.decision.reason] ?? entry.decision.reason}</span></h3>
          {entry.decision.detail && <p className="mw-caption">{entry.decision.detail}</p>}
          <DecisionTrace decision={entry.decision} />
        </section>
      )}
      <section aria-label="Token 与费用">
        <h3>Token 与费用</h3>
        <dl className="mw-log-facts">
          <div><dt>输入</dt><dd>{formatTokens(entry.input)}</dd></div>
          <div><dt>输出</dt><dd>{formatTokens(entry.output)}</dd></div>
          <div><dt>缓存读</dt><dd>{formatTokens(entry.cacheRead)}</dd></div>
          <div><dt>缓存写</dt><dd>{formatTokens(entry.cacheWrite)}</dd></div>
          <div><dt>预估费用</dt><dd>{formatEstimatedUsd(entry.costUsd, 'record')}</dd></div>
          <div><dt>首字耗时</dt><dd>{formatMs(entry.firstTokenMs)}</dd></div>
          <div><dt>输出速度</dt><dd>{formatTps(entry.outputTps)}</dd></div>
          <div><dt>总耗时</dt><dd>{formatMs(entry.latencyMs)}</dd></div>
        </dl>
      </section>
      <section aria-label="Context 构成">
        <h3>Context 构成</h3>
        <ContextBars entry={entry} />
      </section>
      <section aria-label="请求信息">
        <h3>请求信息</h3>
        <dl className="mw-log-facts is-wide">
          <div><dt>请求 ID</dt><dd className="mw-mono-text">{entry.id}</dd></div>
          <div><dt>会话</dt><dd className="mw-mono-text">{entry.session ?? '—'}</dd></div>
          <div><dt>接口</dt><dd>{entry.endpoint}{entry.stream ? ' · 流式' : ''} → {entry.wire}</dd></div>
          <div><dt>开始</dt><dd>{new Date(entry.startedAt).toLocaleString()}</dd></div>
        </dl>
      </section>
    </div>
  );
}

export function RequestLogPage({ onNotify }: { onNotify?: (type: ToastType, text: string) => void }) {
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
      if (mine === generation.current) setLoading(false);
    }
  }, [filters, offset]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!tail) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
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
      onNotify?.('success', `${result.message}：${result.path}`);
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

  return (
    <div className="mw-page-stack mw-log-page">
      <div className="mw-card mw-panel">
        <div className="mw-log-toolbar" role="search" aria-label="筛选请求日志">
          <div className="mw-seg is-sm" role="radiogroup" aria-label="时间范围">
            {RANGES.map((range) => (
              <button key={range.id} type="button" role="radio" aria-checked={filters.range === range.id} className={filters.range === range.id ? 'is-on' : ''} onClick={() => update({ range: range.id })}>{range.label}</button>
            ))}
          </div>
          <select className="mw-native-select is-compact" aria-label="客户端或 Agent" value={filters.agent} onChange={(event) => update({ agent: event.target.value })}>
            <option value="">全部 Agent</option>
            {facets.agents.map((agent) => <option key={agent} value={agent}>{agent}</option>)}
          </select>
          <select className="mw-native-select is-compact" aria-label="供应商" value={filters.provider} onChange={(event) => update({ provider: event.target.value })}>
            <option value="">全部供应商</option>
            {facets.providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
          </select>
          <select className="mw-native-select is-compact" aria-label="模型" value={filters.model} onChange={(event) => update({ model: event.target.value })}>
            <option value="">全部模型</option>
            {facets.models.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
          <select className="mw-native-select is-compact" aria-label="状态" value={filters.status} onChange={(event) => update({ status: event.target.value })}>
            {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <select className="mw-native-select is-compact" aria-label="耗时" value={filters.latency} onChange={(event) => update({ latency: event.target.value })}>
            {LATENCY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <label className="mw-search is-inline mw-log-search">
            <Search className="h-4 w-4" aria-hidden="true" />
            <input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="搜索请求 ID、会话、模型、错误" aria-label="搜索请求日志" />
          </label>
          <div className="mw-log-actions">
            <button type="button" className={`mw-btn ${tail ? 'is-primary' : 'is-ghost'}`} aria-pressed={tail} onClick={toggleTail}>
              <Radio className={`h-3.5 w-3.5 ${tail ? 'mw-log-live' : ''}`} aria-hidden="true" />{tail ? '尾随中' : '实时尾随'}
            </button>
            <button type="button" className="mw-btn is-ghost" onClick={() => void load()} disabled={loading}><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />刷新</button>
            <button type="button" className="mw-btn is-ghost" onClick={() => void runExport()} disabled={exporting || total === 0}><Download className="h-3.5 w-3.5" aria-hidden="true" />{exporting ? '导出中…' : '导出 CSV'}</button>
          </div>
        </div>
        <p className="mw-caption mw-log-summary" aria-live="polite">
          {page ? <>匹配 {total} 条{total > 0 && <>，显示 {offset + 1}–{pageEnd}</>} · 本机保留 {page.retained} 条{page.oldest && <>（最早 {shortTime(page.oldest)}）</>}</> : '读取中…'}
          <InfoTip label="请求日志说明">只记录元数据：时间、Agent、模型、状态、耗时、Token 与 Context 各部分的大小；不保存请求或回复内容。日志在本机轮转，最多约 32 MB，更早的请求只保留在用量统计里。费用按本机价格表估算。</InfoTip>
        </p>
        {error && <p className="mw-caption is-danger" role="alert">{error}</p>}
        {page && page.retained === 0 ? (
          <EmptyState variant="inset" icon={ScrollText} title="还没有经过网关的请求" description="Agent 或你自己的代码经本机网关发出请求后，每一次都会出现在这里。" />
        ) : page && total === 0 ? (
          <EmptyState variant="inset" icon={Search} title="没有符合条件的请求" description={filtered ? '换个筛选条件或清空搜索试试。' : '这个时间范围内没有请求，试试更长的范围。'}>
            {filtered && <button type="button" className="secondary-inline" onClick={() => { setSearchText(''); setFilters({ ...EMPTY_FILTERS, range: filters.range }); setOffset(0); }}>清空筛选</button>}
          </EmptyState>
        ) : (
          <div className="mw-table-wrap">
            <table className="mw-table mw-log-table" aria-label="网关请求日志">
              <thead>
                <tr>
                  <th>时间</th><th>Agent</th><th>模型</th><th>实际转发</th><th>状态</th>
                  <th className="is-num">有效 Token</th><th className="is-num">费用</th><th className="is-num">首字</th><th className="is-num">耗时</th><th className="is-num">输出速度</th>
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
                          <button type="button" className="mw-log-toggle" aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'} ${shortTime(entry.ts)} 的请求详情`} onClick={() => setOpen(expanded ? null : entry.id)}>
                            {shortTime(entry.ts)}
                          </button>
                        </td>
                        <td>{entry.agent ?? '—'}</td>
                        <td className="mw-mono-text">{entry.requestedModel}</td>
                        <td className="mw-mono-text">
                          {entry.provider}/{entry.upstreamModel}
                          {entry.retries > 0 && <span className="mw-chip is-warning mw-log-inline-chip">{entry.switched ? `切换 ${entry.retries}` : `重试 ${entry.retries}`}</span>}
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
                          <td colSpan={10}><EntryDetail entry={entry} /></td>
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
            <button type="button" className="mw-btn is-ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</button>
            <span className="mw-caption">{Math.floor(offset / PAGE_SIZE) + 1} / {Math.ceil(total / PAGE_SIZE)}</span>
            <button type="button" className="mw-btn is-ghost" disabled={pageEnd >= total} onClick={() => { setTail(false); setOffset(offset + PAGE_SIZE); }}>下一页</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default RequestLogPage;
