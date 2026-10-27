import { useEffect, useMemo, useState } from 'react';
import { BellRing, Download, FileText, Image as ImageIcon, Printer, RefreshCw } from 'lucide-react';
import type { DataScope, QuotaProviderEnvelope } from '../../types';
import { selectedZoneDay } from '../../hooks/useBehaviorAnalysis';
import { usePeriodReport, usePeriodReportSettings } from '../../hooks/usePeriodReport';
import { useSegmentedIndicator } from '../../hooks/useSegmentedIndicator';
import { BUDGET_METRIC_LABELS } from '../../hooks/useBudget';
import { formatEstimatedUsd, formatNum, formatTokens } from '../../utils/format';
import { t, useLang, type Lang } from '../../i18n';
import { isRealSessionId, openSessionDetail } from '../../features/sessionDetail/sessionDetailRoute';
import {
  budgetSummary,
  buildPeriodReport,
  DEFAULT_REPORT_OFFSET,
  describeDelta,
  reportPeriodOptions,
  reportTitle,
  type PeriodReport,
  type ReportBreakdownRow,
  type ReportDelta,
  type ReportKind,
  type ReportPeriod,
} from '../../utils/periodReport';
import { budgetPercentText, downloadPeriodReportHtml, downloadPeriodReportImage, printPeriodReport } from '../../utils/periodReportExport';
import { budgetScopeName } from '../settings/BudgetSection';
import { companyQuotaWindowLabel, isCompanyQuotaProvider, quotaWindowDisplayLabel, selectCompanyQuotaWindows } from '../QuotaPanel';
import '../../styles/periodReport.css';

export interface PeriodReportViewProps {
  scope: DataScope;
  timezone: string;
  quotaProviders: readonly QuotaProviderEnvelope[];
  appVersion?: string;
  onNotify: (type: 'info' | 'success' | 'warning' | 'error', text: string) => void;
  /** 测试与截图用：固定「今天」。 */
  today?: string;
}

/** 与额度速览同一套窗口挑选与命名。 */
const QUOTA_LABELS = {
  windows: (provider: QuotaProviderEnvelope) => (isCompanyQuotaProvider(provider.providerId) ? selectCompanyQuotaWindows(provider.windows) : provider.windows),
  label: (window: QuotaProviderEnvelope['windows'][number], provider: QuotaProviderEnvelope) => (
    isCompanyQuotaProvider(provider.providerId) ? companyQuotaWindowLabel(window.windowId) ?? quotaWindowDisplayLabel(window) : quotaWindowDisplayLabel(window)
  ),
};

const KIND_OPTIONS: Array<[ReportKind, 'periodReport.kind.week' | 'periodReport.kind.month']> = [['week', 'periodReport.kind.week'], ['month', 'periodReport.kind.month']];

function DeltaBadge({ delta, invert = false }: { delta: ReportDelta; invert?: boolean }) {
  const lang = useLang();
  const text = describeDelta(delta, lang);
  if (!text) return <span className="report-delta">{t('periodReport.delta.unavailable')}</span>;
  const direction = delta.kind === 'change' ? (delta.percent > 0 ? 'up' : 'down') : 'flat';
  return <span className="report-delta" data-direction={direction} data-invert={invert || undefined}>{text}</span>;
}

function cost(value: number | null, hidden: boolean) {
  if (value === null) return t('periodReport.unavailable');
  return hidden ? t('periodReport.hidden') : formatEstimatedUsd(value);
}

function percent(value: number | null, digits = 1) {
  return value === null ? t('periodReport.unavailable') : `${(value * 100).toFixed(digits)}%`;
}

const BUDGET_LEVEL_KEYS = {
  ok: 'periodReport.budget.level.ok',
  warn: 'periodReport.budget.level.warn',
  over: 'periodReport.budget.level.over',
  unavailable: 'periodReport.unavailable',
} as const;

const WEEKDAY_KEYS = [
  'periodReport.dayBars.weekday.1',
  'periodReport.dayBars.weekday.2',
  'periodReport.dayBars.weekday.3',
  'periodReport.dayBars.weekday.4',
  'periodReport.dayBars.weekday.5',
  'periodReport.dayBars.weekday.6',
  'periodReport.dayBars.weekday.7',
] as const;

function Breakdown({ title, rows, hideCosts, empty }: { title: string; rows: ReportBreakdownRow[] | null; hideCosts: boolean; empty: string }) {
  return (
    <section className="panel report-card report-breakdown" aria-label={title}>
      <header className="report-card-header"><h2>{title}</h2></header>
      {!rows || rows.length === 0 ? <p className="report-empty">{empty}</p> : (
        <ol className="report-rank">
          {rows.map((row) => (
            <li key={row.id}>
              <div className="report-rank-line">
                <span className="report-rank-name" title={row.name}>{row.name}</span>
                <span className="report-rank-value">{row.tokens === null ? t('periodReport.unavailable') : formatTokens(row.tokens)}</span>
              </div>
              <div className="report-rank-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, (row.share ?? 0) * 100)}%` }} /></div>
              <div className="report-rank-meta">
                <span>{percent(row.share, 0)} · {t('periodReport.recordCount', { count: formatNum(row.requests) })} · {cost(row.cost, hideCosts)}</span>
                {row.delta.kind !== 'unavailable' && <DeltaBadge delta={row.delta} />}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function DayBars({ report }: { report: PeriodReport }) {
  const max = Math.max(1, ...report.days.map((day) => day.tokens));
  const dense = report.days.length > 14;
  return (
    <section className="panel report-card report-days" aria-label={t('periodReport.dayBars.title')}>
      <header className="report-card-header">
        <h2>{t('periodReport.dayBars.title')}</h2>
        <span>{report.peakDay ? t('periodReport.dayBars.peak', { date: report.peakDay.date.slice(5), tokens: formatTokens(report.peakDay.tokens) }) : t('periodReport.dayBars.empty')}</span>
      </header>
      <div className="report-day-bars" data-dense={dense || undefined} role="list">
        {report.days.map((day) => (
          <div key={day.date} role="listitem" className="report-day" aria-label={`${day.date} ${formatTokens(day.tokens)}`} data-peak={report.peakDay?.date === day.date || undefined}>
            <span className="report-day-bar" style={{ height: `${Math.max(2, (day.tokens / max) * 100)}%` }} />
            {(!dense || day.date.endsWith('01') || day.date.endsWith('15')) && <span className="report-day-label">{dense ? day.date.slice(5) : t(WEEKDAY_KEYS[(new Date(`${day.date}T12:00:00Z`).getUTCDay() + 6) % 7])}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}

function pickPeriod(options: ReportPeriod[], offset: number): ReportPeriod {
  return options[-offset] ?? options[1];
}

function buildViewReport(
  data: ReturnType<typeof usePeriodReport>['data'],
  period: ReportPeriod,
  scope: DataScope,
  quotaProviders: readonly QuotaProviderEnvelope[],
  lang: Lang,
): PeriodReport | null {
  if (!data) return null;
  return buildPeriodReport({
    period,
    scope,
    current: data.current,
    previous: data.previous,
    behavior: data.behavior,
    quotaProviders,
    quotaLabels: QUOTA_LABELS,
    budgetRules: data.budgetRules,
    lang,
  });
}

/**
 * 用量 · 报告：周报 / 月报。数据管线见 `utils/periodReport.ts`；导出见 `utils/periodReportExport.ts`。
 */
export function PeriodReportView({ scope, timezone, quotaProviders, appVersion, onNotify, today: fixedToday }: PeriodReportViewProps) {
  const lang = useLang();
  const [kind, setKind] = useState<ReportKind>('week');
  const [offset, setOffset] = useState(DEFAULT_REPORT_OFFSET);
  const [hideCosts, setHideCosts] = useState(false);
  const [exporting, setExporting] = useState<'image' | 'html' | 'pdf' | null>(null);
  const today = fixedToday ?? selectedZoneDay(timezone);
  const options = useMemo(() => reportPeriodOptions(kind, today, undefined, lang), [kind, today, lang]);
  const period = pickPeriod(options, offset);
  const { data, loading, error, reload } = usePeriodReport({ scope, period, timezone, active: true });
  const reminder = usePeriodReportSettings();
  const kindRef = useSegmentedIndicator<HTMLDivElement>();

  const report = useMemo(() => buildViewReport(data, period, scope, quotaProviders, lang), [data, period, scope, quotaProviders, lang]);

  useEffect(() => {
    if (reminder.error) onNotify('error', reminder.error);
  }, [onNotify, reminder.error]);

  const runExport = async (target: 'image' | 'html' | 'pdf') => {
    // 导出文件固定中文，与界面语言无关。
    // 期次文字随语言变、日期区间不变，所以按同一期次的中文版本重建。
    const exported = lang === 'zh'
      ? report
      : buildViewReport(data, pickPeriod(reportPeriodOptions(kind, today, undefined, 'zh'), offset), scope, quotaProviders, 'zh');
    if (!exported) return;
    setExporting(target);
    try {
      if (target === 'image') await downloadPeriodReportImage(exported, { hideCosts, appVersion });
      else if (target === 'html') downloadPeriodReportHtml(exported, { hideCosts, appVersion });
      else await printPeriodReport(exported, { hideCosts, appVersion });
      onNotify('success', t(target === 'pdf' ? 'periodReport.export.pdfSuccess' : target === 'image' ? 'periodReport.export.imageSuccess' : 'periodReport.export.htmlSuccess'));
    } catch (cause) {
      onNotify('error', t('periodReport.export.failed', { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setExporting(null);
    }
  };

  const remindOn = kind === 'week' ? reminder.settings.weekly : reminder.settings.monthly;
  const hasOpenableSessions = report?.sessions?.some((session) => isRealSessionId(session.id) && session.toolId.trim().length > 0) ?? false;

  return (
    <div className="content-stack period-report" aria-busy={loading || undefined}>
      <div className="usage-toolbar report-toolbar">
        <div className="segmented tl-seg" role="group" aria-label={t('periodReport.kindAria')} ref={kindRef}>
          {KIND_OPTIONS.map(([id, label]) => (
            <button key={id} type="button" className={kind === id ? 'active' : ''} aria-pressed={kind === id} onClick={() => { setKind(id); setOffset(DEFAULT_REPORT_OFFSET); }}>{t(label)}</button>
          ))}
        </div>
        <label className="report-period-select">
          <span className="sr-only">{t('periodReport.periodAria')}</span>
          <select className="control-select" value={offset} onChange={(event) => setOffset(Number(event.target.value))}>
            {options.map((option, index) => (
              <option key={option.start} value={-index}>{option.shortLabel === option.label ? option.label : `${option.shortLabel} · ${option.label}`}{option.complete ? '' : t('periodReport.runningSuffix')}</option>
            ))}
          </select>
        </label>
        <span className="usage-flex" />
        <label className="report-hide-costs">
          <input type="checkbox" checked={hideCosts} onChange={(event) => setHideCosts(event.target.checked)} />
          {t('periodReport.hideCosts')}
        </label>
        <button type="button" className="icon-command" onClick={() => void runExport('image')} disabled={!report || exporting !== null}><ImageIcon size={16} aria-hidden="true" />{t('periodReport.exportImage')}</button>
        <button type="button" className="icon-command" onClick={() => void runExport('html')} disabled={!report || exporting !== null}><FileText size={16} aria-hidden="true" />HTML</button>
        <button type="button" className="icon-command" onClick={() => void runExport('pdf')} disabled={!report || exporting !== null}><Printer size={16} aria-hidden="true" />PDF</button>
        <button type="button" className="icon-command" aria-label={t('periodReport.refreshAria')} title={t('periodReport.refreshAria')} onClick={() => void reload()} disabled={loading}><RefreshCw size={16} aria-hidden="true" /></button>
      </div>

      {error && report && (
        <div className="report-refresh-error" role="alert">
          <span>{t('periodReport.error.refreshFailed', { error })}</span>
          <button type="button" className="secondary-inline" onClick={() => void reload()}>{t('periodReport.retry')}</button>
        </div>
      )}
      {error && !report && (
        <div className="panel empty-panel report-error" role="alert">
          <p>{t('periodReport.error.loadFailed', { error })}</p>
          <button type="button" className="secondary-inline" onClick={() => void reload()}>{t('periodReport.retry')}</button>
        </div>
      )}
      {loading && !report && <div className="panel report-loading" role="status">{t('periodReport.loading', { period: period.label })}</div>}

      {report && (
        <>
          <section className="panel report-hero" aria-labelledby="report-title">
            <div className="report-hero-main">
              <span className="report-kicker">{period.shortLabel}{period.complete ? '' : ` · ${t('periodReport.running')}`} · {t(scope === 'cloud' ? 'periodReport.scope.cloud' : 'periodReport.scope.local')}</span>
              <h2 id="report-title">{reportTitle(period, lang)}</h2>
              <p className="report-compare">{t('periodReport.compare', { period: period.previousLabel, start: period.previousStart.slice(5), end: period.previousEnd.slice(5) })}</p>
              {report.highlights.length > 0 && (
                <ul className="report-highlights">
                  {report.highlights.map((line) => <li key={line}>{line}</li>)}
                </ul>
              )}
            </div>
            <div className="report-hero-number">
              <span className="report-label">{t('periodReport.tokens')}</span>
              <strong>{formatTokens(report.totals.effectiveTokens)}</strong>
              <DeltaBadge delta={report.deltas.tokens} />
              <span className="report-sub">{t('periodReport.activeDays', { days: report.totals.activeDays })} · {t('periodReport.inputTokens', { tokens: formatTokens(report.totals.inputTokens) })} · {t('periodReport.outputTokens', { tokens: formatTokens(report.totals.outputTokens) })}</span>
            </div>
          </section>

          <div className="report-kpis">
            <div className="panel report-kpi"><span className="report-label">{t('periodReport.estimatedCost')}</span><strong>{cost(report.totals.cost, hideCosts)}</strong>{hideCosts ? <span className="report-delta">{t('periodReport.hidden')}</span> : <DeltaBadge delta={report.deltas.cost} />}</div>
            <div className="panel report-kpi"><span className="report-label">{t('periodReport.requests')}</span><strong>{formatNum(report.totals.requests)}</strong><DeltaBadge delta={report.deltas.requests} /></div>
            <div className="panel report-kpi">
              <span className="report-label">{t('periodReport.cacheReuse')}</span>
              <strong>{percent(report.totals.cacheReuse)}</strong>
              <span className="report-delta" data-direction={report.deltas.cacheReusePoints === null ? 'flat' : report.deltas.cacheReusePoints >= 0 ? 'down' : 'up'}>
                {report.deltas.cacheReusePoints === null
                  ? t('periodReport.cacheReused')
                  : t('periodReport.cachePoints', { sign: report.deltas.cacheReusePoints >= 0 ? '+' : '−', points: Math.abs(report.deltas.cacheReusePoints).toFixed(1) })}
              </span>
            </div>
            <div className="panel report-kpi">
              <span className="report-label">{t('periodReport.budgetReached')}</span>
              <strong>{report.budgets.length === 0 ? t('periodReport.budgets.unset') : `${report.budgets.filter((budget) => budget.level === 'ok').length} / ${report.budgets.length}`}</strong>
              <span className="report-delta">
                {report.budgets.length === 0
                  ? (scope === 'cloud' ? t('periodReport.budgets.cloudHint') : t(kind === 'week' ? 'periodReport.budgets.addWeekly' : 'periodReport.budgets.addMonthly'))
                  : budgetSummary(report.budgets, lang)}
              </span>
            </div>
          </div>

          <DayBars report={report} />

          <div className="report-grid">
            <Breakdown title={t('periodReport.byAgent')} rows={report.agents} hideCosts={hideCosts} empty={t('periodReport.emptyUsage')} />
            <Breakdown title={t('periodReport.byModel')} rows={report.models} hideCosts={hideCosts} empty={t('periodReport.emptyUsage')} />
            <Breakdown title={t('periodReport.byAccount')} rows={report.accounts} hideCosts={hideCosts} empty={t(scope === 'cloud' ? 'periodReport.accounts.cloudEmpty' : 'periodReport.accounts.localEmpty')} />
          </div>

          <div className="report-grid report-grid-2">
            <section className="panel report-card" aria-label={t('periodReport.topSessions')}>
              <header className="report-card-header"><h2>{t('periodReport.topSessions')}</h2>{report.sessionsNote && <span>{report.sessionsNote}</span>}</header>
              {hasOpenableSessions && <p className="report-session-hint">{t('sessionDetail.fullHistoryHint')}</p>}
              {!report.sessions ? <p className="report-empty">{t(scope === 'cloud' ? 'periodReport.sessions.cloudEmpty' : 'periodReport.sessions.unavailable')}</p>
                : report.sessions.length === 0 ? <p className="report-empty">{t('periodReport.sessions.empty')}</p> : (
                  <ol className="report-sessions">
                    {report.sessions.map((session, index) => {
                      const canOpen = isRealSessionId(session.id) && session.toolId.trim().length > 0;
                      return (
                        <li key={`${session.toolId}\u0000${session.id}`}>
                          <span className="report-session-rank">{index + 1}</span>
                          <div className="report-session-main">
                            <strong>{session.tool}{session.model ? ` · ${session.model}` : ''}</strong>
                            <span>{session.firstAt ? session.firstAt.slice(5, 16) : t('periodReport.session.timeUnknown')} · {t('periodReport.recordCount', { count: formatNum(session.requests) })} · {formatTokens(session.tokens)}</span>
                            {canOpen && (
                              <div className="report-session-entry">
                                <button
                                  type="button"
                                  className="secondary-inline"
                                  aria-label={t('sessionDetail.openAria', { id: session.id })}
                                  onClick={() => openSessionDetail({ sessionId: session.id, tool: session.toolId })}
                                >
                                  {t('sessionDetail.open')}
                                </button>
                              </div>
                            )}
                          </div>
                          <span className="report-session-cost">{cost(session.cost, hideCosts)}</span>
                        </li>
                      );
                    })}
                  </ol>
                )}
            </section>
            <section className="panel report-card" aria-label={t('periodReport.quotas.title')}>
              <header className="report-card-header"><h2>{t('periodReport.quotas.title')}</h2><span>{t('periodReport.quotas.currentReading')}</span></header>
              {report.budgets.length === 0 && report.quotas.length === 0 && <p className="report-empty">{t('periodReport.quotas.empty')}</p>}
              {report.budgets.length > 0 && (
                <ul className="report-meters">
                  {report.budgets.map((budget) => (
                    <li key={budget.id} data-level={budget.level}>
                      <div className="report-rank-line">
                        <span className="report-rank-name">{budgetScopeName(budget.rule)} · {BUDGET_METRIC_LABELS[budget.rule.metric]}</span>
                        <span className="report-rank-value">{budget.percent === null ? t('periodReport.unavailable') : budgetPercentText(budget, hideCosts)}</span>
                      </div>
                      {!(hideCosts && budget.rule.metric === 'cost') && <div className="report-rank-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, budget.percent ?? 0)}%` }} /></div>}
                      <div className="report-rank-meta">
                        <span>{budget.rule.metric === 'cost' ? `${cost(budget.used, hideCosts)} / ${cost(budget.rule.limit, hideCosts)}` : `${formatTokens(budget.used)} / ${formatTokens(budget.rule.limit)}`}</span>
                        <span>{t(BUDGET_LEVEL_KEYS[budget.level])}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {report.quotas.length > 0 && (
                <ul className="report-meters report-quotas">
                  {report.quotas.slice(0, 6).map((quota) => (
                    <li key={quota.key} data-level={quota.stale ? 'stale' : quota.level}>
                      <div className="report-rank-line">
                        <span className="report-rank-name">{quota.provider} · {quota.window}</span>
                        <span className="report-rank-value">{quota.stale ? t('periodReport.quotas.stale') : ''}{t('periodReport.quotas.remaining', { percent: quota.remaining })}</span>
                      </div>
                      <div className="report-rank-bar" aria-hidden="true"><i style={{ width: `${Math.max(2, quota.remaining)}%` }} /></div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="panel report-card report-reminder" aria-label={t('periodReport.reminder.aria')}>
            <BellRing size={18} aria-hidden="true" />
            <div>
              <strong>{t(kind === 'week' ? 'periodReport.reminder.weeklyTitle' : 'periodReport.reminder.monthlyTitle')}</strong>
              <span>{t('periodReport.reminder.description')}</span>
            </div>
            <button
              type="button"
              role="switch"
              className="sf-switch"
              aria-label={t(kind === 'week' ? 'periodReport.reminder.weeklyAria' : 'periodReport.reminder.monthlyAria')}
              aria-checked={remindOn}
              aria-busy={reminder.saving || undefined}
              disabled={reminder.saving || !reminder.loaded}
              title={reminder.loaded ? undefined : t('periodReport.reminder.notLoaded')}
              onClick={() => void reminder.save(kind === 'week' ? { ...reminder.settings, weekly: !remindOn } : { ...reminder.settings, monthly: !remindOn })}
            />
          </section>
          <p className="report-footnote"><Download size={12} aria-hidden="true" /> {t('periodReport.footnote')}</p>
        </>
      )}
    </div>
  );
}

export default PeriodReportView;
