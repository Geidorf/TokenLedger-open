import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Coins, Database, GitBranch, ListTree, RefreshCw, Rows3, Timer, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { EChart } from '../../components/EChart';
import { InfoTip } from '../../components/InfoTip';
import { t as translate, useLang, useT, type Lang } from '../../i18n';
import type { SessionAnalysisRecord } from '../../types/sessionAnalysis';
import { getChartAnimation, getChartGrid, getChartThemeTokens, getChartTooltip, lineAreaGradient, type ChartThemeTokens } from '../../utils/chartTheme';
import { CONTEXT_SEGMENTS } from '../../utils/contextComposition';
import { escapeHtml } from '../../utils/frontendContracts';
import { formatAxisTokens, formatEstimatedUsd, formatNum, formatTokens, isKnownCost } from '../../utils/format';
import { useTheme } from '../../utils/useTheme';
import { contextSeries, effectiveTokens, localDay, ratioToAverage, windowTotals, requestCount, topExpensive, type PeerAverage, type SessionSummary, type TimelineEntry } from './sessionDetailData';
import type { SessionDetailRef } from './sessionDetailRoute';
import { useSessionDetail } from './useSessionDetail';
import './sessionDetail.css';

const SessionAnalysisDrawer = lazy(() => import('../../components/SessionAnalysisDrawer'));

/** 逐轮分析目前只支持这两种来源的本机会话文件（与请求明细的入口一致）。 */
const TURN_ANALYSIS_TOOLS = new Set(['claude', 'codex']);
const TIMELINE_PAGE = 100;

const TIME_FORMAT: Record<Lang, Intl.DateTimeFormat> = {
  zh: new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
  en: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
};
const CLOCK_FORMAT: Record<Lang, Intl.DateTimeFormat> = {
  zh: new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
  en: new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
};

function formatTime(value: string | null, lang: Lang): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : TIME_FORMAT[lang].format(date);
}

function formatClock(value: string, lang: Lang): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : CLOCK_FORMAT[lang].format(date);
}

function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const percent = (value: number) => `${(value * 100).toFixed(value >= 0.1 || value === 0 ? 0 : 1)}%`;
const usd = (value: number) => formatEstimatedUsd(value, 'record');

type Translate = ReturnType<typeof useT>;

function formatDuration(ms: number, t: Translate): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return t('sessionDetail.duration.s', { s: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('sessionDetail.duration.m', { m: minutes });
  return t('sessionDetail.duration.hm', { h: Math.floor(minutes / 60), m: minutes % 60 });
}

function Stat({ icon: Icon, label, value, note }: { icon: LucideIcon; label: string; value: string; note?: string | null }) {
  return (
    <div className="panel behavior-stat session-detail-stat">
      <span className="behavior-stat-icon" aria-hidden="true"><Icon className="h-4 w-4" /></span>
      <span className="behavior-stat-text">
        <span className="behavior-stat-label">{label}</span>
        <strong>{value}</strong>
        {note && <small className="behavior-stat-note">{note}</small>}
      </span>
    </div>
  );
}

function costOption(timeline: TimelineEntry[], theme: ChartThemeTokens, lang: Lang) {
  const t = (key: Parameters<typeof translate>[0]) => translate(key, undefined, lang);
  const color = theme.seriesPalette[0];
  const labels = timeline.map(entry => `#${entry.ordinal}`);
  return {
    color: [color, theme.seriesPalette[2]],
    ...getChartAnimation(theme.reduceMotion),
    tooltip: getChartTooltip(theme, {
      trigger: 'axis',
      formatter: (params: Array<{ dataIndex: number }>) => {
        const entry = timeline[params[0]?.dataIndex ?? 0];
        if (!entry) return '';
        const cost = isKnownCost(entry.item.cost) ? usd(entry.item.cost) : t('sessionDetail.unavailableValue');
        return [
          `<b>#${entry.ordinal}</b> · ${escapeHtml(formatTime(entry.item.timestamp, lang))}`,
          escapeHtml(entry.item.model),
          `${t('sessionDetail.cost.request')}: ${cost}`,
          `${t('sessionDetail.cost.series')}: ${usd(entry.cumulativeCost)}`,
        ].join('<br/>');
      },
    }),
    grid: getChartGrid({ top: 16, bottom: 8 }),
    xAxis: {
      type: 'category',
      data: labels,
      boundaryGap: false,
      axisLine: { lineStyle: { color: theme.border } },
      axisTick: { show: false },
      axisLabel: { color: theme.textTertiary, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      splitNumber: 3,
      axisLabel: { color: theme.textTertiary, fontSize: 11, formatter: (value: number) => `$${value < 10 ? value.toFixed(2) : Math.round(value)}` },
      splitLine: { lineStyle: { color: theme.borderFaint } },
    },
    series: [
      {
        name: t('sessionDetail.cost.series'),
        type: 'line',
        step: 'end',
        symbol: 'none',
        lineStyle: { width: 2 },
        areaStyle: { color: lineAreaGradient(color) },
        data: timeline.map(entry => Number(entry.cumulativeCost.toFixed(6))),
      },
    ],
  };
}

function contextOption(points: ReturnType<typeof contextSeries>, theme: ChartThemeTokens, lang: Lang) {
  return {
    color: CONTEXT_SEGMENTS.map((_, index) => theme.seriesPalette[index]),
    ...getChartAnimation(theme.reduceMotion),
    tooltip: getChartTooltip(theme, {
      trigger: 'axis',
      valueFormatter: (value: number) => `≈${formatTokens(value)}`,
    }),
    legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 8, textStyle: { color: theme.textSecondary, fontSize: 11 } },
    grid: getChartGrid({ top: 34, bottom: 8 }),
    xAxis: {
      type: 'category',
      data: points.map(point => `#${point.ordinal} ${formatClock(point.timestamp, lang)}`),
      boundaryGap: false,
      axisLine: { lineStyle: { color: theme.border } },
      axisTick: { show: false },
      axisLabel: { color: theme.textTertiary, fontSize: 11, hideOverlap: true, formatter: (value: string) => value.split(' ')[0] },
    },
    yAxis: {
      type: 'value',
      splitNumber: 3,
      axisLabel: { color: theme.textTertiary, fontSize: 11, formatter: formatAxisTokens },
      splitLine: { lineStyle: { color: theme.borderFaint } },
    },
    series: CONTEXT_SEGMENTS.map(({ key, label }) => ({
      name: label,
      type: 'line',
      stack: 'context',
      symbol: 'none',
      lineStyle: { width: 1 },
      areaStyle: { opacity: 0.55 },
      data: points.map(point => point.segments[key]),
    })),
  };
}

function PeerPanel({ peer, summary, timeline, timezone, t }: { peer: PeerAverage | null | 'loading' | 'failed'; summary: SessionSummary; timeline: TimelineEntry[]; timezone: string; t: Translate }) {
  let body;
  if (summary.tools.length > 1) body = <p className="session-detail-muted">{t('sessionDetail.peer.mixed')}</p>;
  else if (peer === 'loading') body = <p className="session-detail-muted" role="status">{t('sessionDetail.peer.loading')}</p>;
  else if (peer === 'failed') body = <p className="session-detail-muted">{t('sessionDetail.peer.failed')}</p>;
  else if (!peer) body = <p className="session-detail-muted">{t('sessionDetail.peer.none')}</p>;
  else {
    const self = windowTotals(timeline, { start: peer.windowStart, end: peer.windowEnd }, timezone);
    const rows: Array<[string, number | null, number | null, (value: number) => string]> = [
      [t('sessionDetail.peer.cost'), self.cost, peer.cost, usd],
      [t('sessionDetail.peer.tokens'), self.tokens, peer.tokens, formatTokens],
      [t('sessionDetail.peer.rows'), self.rows, peer.rows, value => formatNum(Math.round(value))],
    ];
    body = (
      <>
        <p className="session-detail-muted">{t('sessionDetail.peer.basis', { tool: peer.tool, start: peer.windowStart, end: peer.windowEnd, count: formatNum(peer.sessions) })}</p>
        <table className="session-detail-peer">
          <thead>
            <tr><th scope="col">{t('sessionDetail.peer.metric')}</th><th scope="col">{t('sessionDetail.peer.self')}</th><th scope="col">{t('sessionDetail.peer.average')}</th><th scope="col">{t('sessionDetail.peer.ratio')}</th></tr>
          </thead>
          <tbody>
            {rows.map(([label, self, average, format]) => {
              const ratio = ratioToAverage(self, average);
              const level = ratio === null ? '' : ratio >= 2 ? ' is-high' : ratio <= 0.5 ? ' is-low' : '';
              return (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td>{self === null ? t('sessionDetail.unavailableValue') : format(self)}</td>
                  <td>{average === null ? t('sessionDetail.unavailableValue') : format(average)}</td>
                  <td><span className={`session-detail-ratio${level}`}>{ratio === null ? '—' : `×${ratio.toFixed(ratio >= 10 ? 0 : 1)}`}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {peer.topOnly && <p className="session-detail-muted">{t('sessionDetail.peer.topOnly')}</p>}
      </>
    );
  }
  return (
    <section className="panel session-detail-card" aria-labelledby="session-detail-peer-title">
      <div className="workbuddy-card-header"><h2 id="session-detail-peer-title">{t('sessionDetail.peer.title')}<InfoTip label={t('sessionDetail.peer.title')}>{t('sessionDetail.peer.hint')}</InfoTip></h2></div>
      {body}
    </section>
  );
}

export interface SessionDetailPageProps {
  sessionRef: SessionDetailRef;
  timezone: string;
  onBack: () => void;
  /** 在「请求」子页按这个会话筛选明细；`range` 是会话首末记录所在的本地日期。 */
  onOpenRequests: (target: { sessionId: string; tool: string | null; range: { start: string; end: string } | null }) => void;
}

/**
 * 「用量 › 会话」里的单个会话详情：概要、累计费用、同类对比、Context 构成变化、
 * 最贵的请求与逐请求时间线。数据只来自本机明细与行为分析（见 sessionDetailData.ts）。
 */
export default function SessionDetailPage({ sessionRef, timezone, onBack, onOpenRequests }: SessionDetailPageProps) {
  const t = useT();
  const lang = useLang();
  const { effective } = useTheme();
  const [revision, setRevision] = useState(0);
  const { state, timeline, summary, peer } = useSessionDetail(sessionRef, timezone, revision);
  const [visible, setVisible] = useState(TIMELINE_PAGE);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [turnRecord, setTurnRecord] = useState<SessionAnalysisRecord | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const theme = useMemo(() => getChartThemeTokens(effective), [effective]);
  const contextPoints = useMemo(() => contextSeries(timeline), [timeline]);
  const top = useMemo(() => topExpensive(timeline), [timeline]);
  const costChart = useMemo(() => costOption(timeline, theme, lang), [timeline, theme, lang]);
  const contextChart = useMemo(() => contextOption(contextPoints, theme, lang), [contextPoints, theme, lang]);

  useEffect(() => { setVisible(TIMELINE_PAGE); setHighlight(null); }, [sessionRef.sessionId, sessionRef.tool]);
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, [sessionRef.sessionId, sessionRef.tool]);

  const jumpTo = (ordinal: number) => {
    if (ordinal > visible) setVisible(Math.ceil(ordinal / TIMELINE_PAGE) * TIMELINE_PAGE);
    setHighlight(ordinal);
    window.requestAnimationFrame(() => {
      const row = document.getElementById(`session-detail-row-${ordinal}`);
      row?.scrollIntoView({ block: 'center', behavior: theme.reduceMotion ? 'auto' : 'smooth' });
      row?.focus({ preventScroll: true });
    });
  };

  const tool = summary?.tools.length === 1 ? summary.tool : sessionRef.tool;
  const turnTool = (tool ?? '').toLowerCase();
  const firstRecord = timeline.find(entry => Number.isSafeInteger(entry.item.id) && entry.item.id > 0)?.item;
  const firstDay = summary?.firstAt ? localDay(summary.firstAt, timezone) : null;
  const lastDay = summary?.lastAt ? localDay(summary.lastAt, timezone) : null;
  const requestsRange = firstDay && lastDay ? { start: firstDay, end: lastDay } : null;
  const canAnalyzeTurns = Boolean(firstRecord && TURN_ANALYSIS_TOOLS.has(turnTool));

  return (
    <div className="session-detail" data-testid="session-detail">
      <div className="session-detail-bar">
        <button type="button" className="ghost-inline session-detail-back" onClick={onBack}><ArrowLeft className="h-4 w-4" aria-hidden="true" />{t('sessionDetail.back')}</button>
        <div className="session-detail-actions">
          {canAnalyzeTurns && firstRecord && (
            <button type="button" className="ghost-inline" onClick={() => setTurnRecord({ id: firstRecord.id, sessionId: firstRecord.sessionId, tool: firstRecord.tool })}><ListTree className="h-4 w-4" aria-hidden="true" />{t('sessionDetail.action.turns')}</button>
          )}
          <button type="button" className="ghost-inline" onClick={() => onOpenRequests({ sessionId: sessionRef.sessionId, tool, range: requestsRange })}><Rows3 className="h-4 w-4" aria-hidden="true" />{t('sessionDetail.action.requests')}</button>
          <button type="button" className="ghost-inline" aria-disabled={state.status === 'loading' || undefined} onClick={() => { if (state.status !== 'loading') setRevision(value => value + 1); }}><RefreshCw className={`h-4 w-4 ${state.status === 'loading' ? 'animate-spin' : ''}`} aria-hidden="true" />{t('sessionDetail.action.refresh')}</button>
        </div>
      </div>

      <header className="panel session-detail-head">
        <span className="session-detail-eyebrow">{tool ? t('sessionDetail.eyebrow', { tool }) : t('sessionDetail.eyebrowAnyTool')}</span>
        <h2 ref={headingRef} tabIndex={-1} id="session-detail-title">{t('sessionDetail.title')}</h2>
        <code className="session-detail-id" title={t('sessionDetail.idLabel')}>{sessionRef.sessionId}</code>
        {summary && (
          <p className="session-detail-meta">
            <span>{t('sessionDetail.span', { start: formatTime(summary.firstAt, lang), end: formatTime(summary.lastAt, lang) })}</span>
            {summary.durationMs !== null && <span>{t('sessionDetail.lasted', { duration: formatDuration(summary.durationMs, t) })}</span>}
            <span>{t('sessionDetail.models', { models: summary.models.join(t('sessionDetail.listSeparator')) })}</span>
          </p>
        )}
        {summary && summary.tools.length > 1 && <p className="session-detail-muted">{t('sessionDetail.toolsMixed', { tools: summary.tools.join(t('sessionDetail.listSeparator')) })}</p>}
      </header>

      {state.status === 'loading' && <div className="panel session-detail-state" role="status">{t('sessionDetail.loading')}</div>}
      {state.status === 'failed' && <div className="panel session-detail-state" role="alert"><h3>{t('sessionDetail.failed.title')}</h3><p>{t('sessionDetail.failed.body')}</p></div>}
      {state.status === 'unavailable' && <div className="panel session-detail-state" role="status"><h3>{t('sessionDetail.unavailable.title')}</h3><p>{t('sessionDetail.unavailable.body')}</p></div>}
      {state.status === 'empty' && <div className="panel session-detail-state" role="status"><h3>{t('sessionDetail.empty.title')}</h3><p>{t('sessionDetail.empty.body', { id: sessionRef.sessionId })}</p></div>}

      {state.status === 'ready' && summary && (
        <>
          {state.result.truncated && <p className="session-detail-notice" role="status">{t('sessionDetail.truncated', { count: formatNum(summary.rows) })}</p>}
          <div className="session-detail-stats">
            <Stat icon={Coins} label={t('sessionDetail.stat.cost')} value={summary.cost !== null ? usd(summary.cost) : usd(summary.knownCost)} note={summary.unknownCostRows > 0 ? t('sessionDetail.stat.costPartial', { count: formatNum(summary.unknownCostRows) }) : null} />
            <Stat icon={Zap} label={t('sessionDetail.stat.tokens')} value={formatTokens(summary.effectiveTokens)} note={t('sessionDetail.stat.tokensNote', { input: formatTokens(summary.inputTokens), output: formatTokens(summary.outputTokens) })} />
            <Stat icon={Rows3} label={t('sessionDetail.stat.requests')} value={formatNum(summary.rows)} note={summary.requests !== null && summary.requests !== summary.rows ? t('sessionDetail.stat.requestsNote', { count: formatNum(summary.requests) }) : null} />
            <Stat icon={Database} label={t('sessionDetail.stat.cacheHit')} value={summary.cacheHit === null ? t('sessionDetail.unavailableValue') : percent(summary.cacheHit)} note={summary.cacheHit === null ? t('sessionDetail.stat.cacheUnknown') : t('sessionDetail.stat.cacheNote', { cached: formatTokens(summary.cachedTokens) })} />
            <Stat icon={GitBranch} label={t('sessionDetail.stat.switches')} value={formatNum(summary.modelSwitches)} note={t('sessionDetail.stat.switchesNote', { count: formatNum(summary.models.length) })} />
            <Stat icon={Timer} label={t('sessionDetail.stat.latency')} value={summary.latencyMedianMs === null ? t('sessionDetail.unavailableValue') : formatLatency(summary.latencyMedianMs)} note={summary.latencyTotalMs === null ? t('sessionDetail.stat.latencyNone') : t('sessionDetail.stat.latencyNote', { total: formatDuration(summary.latencyTotalMs, t), count: formatNum(summary.latencyRows) })} />
          </div>

          <div className="session-detail-grid">
            <section className="panel session-detail-card" aria-labelledby="session-detail-cost-title">
              <div className="workbuddy-card-header"><h2 id="session-detail-cost-title">{t('sessionDetail.cost.title')}<InfoTip label={t('sessionDetail.cost.title')}>{t('sessionDetail.cost.hint')}</InfoTip></h2><span>{usd(summary.knownCost)}</span></div>
              <div className="session-detail-chart"><EChart option={costChart} ariaLabel={t('sessionDetail.cost.aria')} onEvents={{ click: (params: { dataIndex?: number }) => { if (typeof params.dataIndex === 'number') jumpTo(params.dataIndex + 1); } }} /></div>
            </section>
            <PeerPanel peer={peer} summary={summary} timeline={timeline} timezone={timezone} t={t} />
          </div>

          <div className="session-detail-grid">
            <section className="panel session-detail-card" aria-labelledby="session-detail-context-title">
              <div className="workbuddy-card-header"><h2 id="session-detail-context-title">{t('sessionDetail.context.title')}<InfoTip label={t('sessionDetail.context.title')}>{t('sessionDetail.context.hint')}</InfoTip></h2>{contextPoints.length > 0 && <span>{t('sessionDetail.context.basis', { count: formatNum(contextPoints.length) })}</span>}</div>
              {contextPoints.length > 0
                ? <div className="session-detail-chart"><EChart option={contextChart} ariaLabel={t('sessionDetail.context.aria')} onEvents={{ click: (params: { dataIndex?: number }) => { if (typeof params.dataIndex === 'number' && contextPoints[params.dataIndex]) jumpTo(contextPoints[params.dataIndex].ordinal); } }} /></div>
                : <p className="session-detail-muted session-detail-empty-chart">{t('sessionDetail.context.none')}</p>}
            </section>
            <section className="panel session-detail-card" aria-labelledby="session-detail-top-title">
              <div className="workbuddy-card-header"><h2 id="session-detail-top-title">{t('sessionDetail.top.title')}<InfoTip label={t('sessionDetail.top.title')}>{t('sessionDetail.top.hint')}</InfoTip></h2></div>
              {top.length === 0 ? <p className="session-detail-muted">{t('sessionDetail.top.none')}</p> : (
                <ol className="session-detail-top">
                  {top.map(entry => (
                    <li key={entry.ordinal}>
                      <button type="button" onClick={() => jumpTo(entry.ordinal)}>
                        <span className="session-detail-top-main">
                          <strong>{usd(entry.item.cost)}</strong>
                          <small>{t('sessionDetail.top.item', { ordinal: entry.ordinal, time: formatTime(entry.item.timestamp, lang) })}</small>
                        </span>
                        <span className="session-detail-top-meta">
                          <span>{entry.item.model}</span>
                          <small>{formatTokens(effectiveTokens(entry.item))}{summary.knownCost > 0 ? ` · ${t('sessionDetail.top.share', { percent: percent(entry.item.cost / summary.knownCost) })}` : ''}</small>
                        </span>
                        <i className="session-detail-top-bar" style={{ inlineSize: `${Math.max(2, (entry.item.cost / top[0].item.cost) * 100)}%` }} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>

          <section className="panel session-detail-card" aria-labelledby="session-detail-timeline-title">
            <div className="workbuddy-card-header"><h2 id="session-detail-timeline-title">{t('sessionDetail.timeline.title')}<InfoTip label={t('sessionDetail.timeline.title')}>{t('sessionDetail.basis')}</InfoTip></h2><span>{t('sessionDetail.timeline.count', { count: formatNum(timeline.length) })}</span></div>
            <div className="session-detail-table-wrap tl-scrollbar" role="region" aria-labelledby="session-detail-timeline-title" tabIndex={0}>
              <table className="session-detail-table">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">{t('sessionDetail.timeline.col.time')}</th>
                    <th scope="col">{t('sessionDetail.timeline.col.model')}</th>
                    <th scope="col" className="is-num">{t('sessionDetail.timeline.col.input')}</th>
                    <th scope="col" className="is-num">{t('sessionDetail.timeline.col.output')}</th>
                    <th scope="col" className="is-num">{t('sessionDetail.timeline.col.cache')}</th>
                    <th scope="col" className="is-num">{t('sessionDetail.timeline.col.hit')}</th>
                    <th scope="col" className="is-num">{t('sessionDetail.timeline.col.cost')}</th>
                    <th scope="col" className="is-num">{t('sessionDetail.timeline.col.cumulative')}</th>
                    <th scope="col" className="is-num">{t('sessionDetail.timeline.col.latency')}</th>
                  </tr>
                </thead>
                <tbody>
                  {timeline.slice(0, visible).map(entry => {
                    const { item } = entry;
                    const count = requestCount(item);
                    return (
                      <tr key={`${item.id}-${entry.ordinal}`} id={`session-detail-row-${entry.ordinal}`} tabIndex={-1} className={highlight === entry.ordinal ? 'is-highlighted' : undefined}>
                        <td className="is-index">{entry.ordinal}</td>
                        <td>{formatTime(item.timestamp, lang)}{count !== null && count > 1 && <small className="session-detail-aggregated">{t('sessionDetail.timeline.aggregated', { count: formatNum(count) })}</small>}</td>
                        <td className="is-model">
                          <span title={item.model}>{item.model}</span>
                          {entry.switchedFrom !== null && <span className="session-detail-switch" title={t('sessionDetail.timeline.switchTitle', { from: entry.switchedFrom, to: item.model })}>{t('sessionDetail.timeline.switch')}</span>}
                        </td>
                        <td className="is-num">{formatTokens(item.inputTokens)}</td>
                        <td className="is-num">{formatTokens(item.outputTokens)}</td>
                        <td className="is-num">{formatTokens(item.cachedTokens)}</td>
                        <td className="is-num">{entry.cacheHit === null ? '—' : percent(entry.cacheHit)}</td>
                        <td className="is-num">{isKnownCost(item.cost) ? usd(item.cost) : t('sessionDetail.unavailableValue')}</td>
                        <td className="is-num is-muted">{usd(entry.cumulativeCost)}</td>
                        <td className="is-num">{typeof item.latencyMs === 'number' && item.latencyMs > 0 ? formatLatency(item.latencyMs) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {visible < timeline.length && (
              <button type="button" className="ghost-inline session-detail-more" onClick={() => setVisible(value => value + TIMELINE_PAGE)}>{t('sessionDetail.timeline.more', { count: formatNum(Math.min(TIMELINE_PAGE, timeline.length - visible)) })}</button>
            )}
          </section>
        </>
      )}
      {turnRecord && <Suspense fallback={null}><SessionAnalysisDrawer record={turnRecord} onClose={() => setTurnRecord(null)} /></Suspense>}
    </div>
  );
}
