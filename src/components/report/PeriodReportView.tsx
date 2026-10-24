import { useEffect, useMemo, useState } from 'react';
import { BellRing, Download, FileText, Image as ImageIcon, Printer, RefreshCw } from 'lucide-react';
import type { DataScope, QuotaProviderEnvelope } from '../../types';
import { selectedZoneDay } from '../../hooks/useBehaviorAnalysis';
import { usePeriodReport, usePeriodReportSettings } from '../../hooks/usePeriodReport';
import { useSegmentedIndicator } from '../../hooks/useSegmentedIndicator';
import { BUDGET_METRIC_LABELS } from '../../hooks/useBudget';
import { formatEstimatedUsd, formatNum, formatTokens } from '../../utils/format';
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

const KIND_OPTIONS: Array<[ReportKind, string]> = [['week', '周报'], ['month', '月报']];

function DeltaBadge({ delta, invert = false }: { delta: ReportDelta; invert?: boolean }) {
  const text = describeDelta(delta);
  if (!text) return <span className="report-delta">与上期比 —</span>;
  const direction = delta.kind === 'change' ? (delta.percent > 0 ? 'up' : 'down') : 'flat';
  return <span className="report-delta" data-direction={direction} data-invert={invert || undefined}>{text}</span>;
}

function cost(value: number | null, hidden: boolean) {
  if (value === null) return '不可得';
  return hidden ? '已隐藏' : formatEstimatedUsd(value);
}

function percent(value: number | null, digits = 1) {
  return value === null ? '不可得' : `${(value * 100).toFixed(digits)}%`;
}

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
                <span className="report-rank-value">{row.tokens === null ? '不可得' : formatTokens(row.tokens)}</span>
              </div>
              <div className="report-rank-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, (row.share ?? 0) * 100)}%` }} /></div>
              <div className="report-rank-meta">
                <span>{percent(row.share, 0)} · {formatNum(row.requests)} 条 · {cost(row.cost, hideCosts)}</span>
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
    <section className="panel report-card report-days" aria-label="每日有效 Token">
      <header className="report-card-header">
        <h2>每日有效 Token</h2>
        <span>{report.peakDay ? `峰值 ${report.peakDay.date.slice(5)} · ${formatTokens(report.peakDay.tokens)}` : '本期暂无用量'}</span>
      </header>
      <div className="report-day-bars" data-dense={dense || undefined} role="list">
        {report.days.map((day) => (
          <div key={day.date} role="listitem" className="report-day" aria-label={`${day.date} ${formatTokens(day.tokens)}`} data-peak={report.peakDay?.date === day.date || undefined}>
            <span className="report-day-bar" style={{ height: `${Math.max(2, (day.tokens / max) * 100)}%` }} />
            {(!dense || day.date.endsWith('01') || day.date.endsWith('15')) && <span className="report-day-label">{dense ? day.date.slice(5) : ['一', '二', '三', '四', '五', '六', '日'][(new Date(`${day.date}T12:00:00Z`).getUTCDay() + 6) % 7]}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * 用量 · 报告：周报 / 月报。数据管线见 `utils/periodReport.ts`；导出见 `utils/periodReportExport.ts`。
 */
export function PeriodReportView({ scope, timezone, quotaProviders, appVersion, onNotify, today: fixedToday }: PeriodReportViewProps) {
  const [kind, setKind] = useState<ReportKind>('week');
  const [offset, setOffset] = useState(DEFAULT_REPORT_OFFSET);
  const [hideCosts, setHideCosts] = useState(false);
  const [exporting, setExporting] = useState<'image' | 'html' | 'pdf' | null>(null);
  const today = fixedToday ?? selectedZoneDay(timezone);
  const options = useMemo(() => reportPeriodOptions(kind, today), [kind, today]);
  const period = options[-offset] ?? options[1];
  const { data, loading, error, reload } = usePeriodReport({ scope, period, timezone, active: true });
  const reminder = usePeriodReportSettings();
  const kindRef = useSegmentedIndicator<HTMLDivElement>();

  const report = useMemo(() => (data ? buildPeriodReport({
    period,
    scope,
    current: data.current,
    previous: data.previous,
    behavior: data.behavior,
    quotaProviders,
    quotaLabels: QUOTA_LABELS,
    budgetRules: data.budgetRules,
  }) : null), [data, period, scope, quotaProviders]);

  useEffect(() => {
    if (reminder.error) onNotify('error', reminder.error);
  }, [onNotify, reminder.error]);

  const runExport = async (target: 'image' | 'html' | 'pdf') => {
    if (!report) return;
    setExporting(target);
    try {
      if (target === 'image') await downloadPeriodReportImage(report, { hideCosts, appVersion });
      else if (target === 'html') downloadPeriodReportHtml(report, { hideCosts, appVersion });
      else await printPeriodReport(report, { hideCosts, appVersion });
      onNotify('success', target === 'pdf' ? '已打开打印，选择「另存为 PDF」即可保存' : target === 'image' ? '报告图片已导出' : 'HTML 报告已导出');
    } catch (cause) {
      onNotify('error', `导出失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setExporting(null);
    }
  };

  const remindOn = kind === 'week' ? reminder.settings.weekly : reminder.settings.monthly;

  return (
    <div className="content-stack period-report" aria-busy={loading || undefined}>
      <div className="usage-toolbar report-toolbar">
        <div className="segmented tl-seg" role="group" aria-label="报告类型" ref={kindRef}>
          {KIND_OPTIONS.map(([id, label]) => (
            <button key={id} type="button" className={kind === id ? 'active' : ''} aria-pressed={kind === id} onClick={() => { setKind(id); setOffset(DEFAULT_REPORT_OFFSET); }}>{label}</button>
          ))}
        </div>
        <label className="report-period-select">
          <span className="sr-only">报告期次</span>
          <select className="control-select" value={offset} onChange={(event) => setOffset(Number(event.target.value))}>
            {options.map((option, index) => (
              <option key={option.start} value={-index}>{option.shortLabel === option.label ? option.label : `${option.shortLabel} · ${option.label}`}{option.complete ? '' : '（进行中）'}</option>
            ))}
          </select>
        </label>
        <span className="usage-flex" />
        <label className="report-hide-costs">
          <input type="checkbox" checked={hideCosts} onChange={(event) => setHideCosts(event.target.checked)} />
          隐藏费用
        </label>
        <button type="button" className="icon-command" onClick={() => void runExport('image')} disabled={!report || exporting !== null}><ImageIcon size={16} aria-hidden="true" />图片</button>
        <button type="button" className="icon-command" onClick={() => void runExport('html')} disabled={!report || exporting !== null}><FileText size={16} aria-hidden="true" />HTML</button>
        <button type="button" className="icon-command" onClick={() => void runExport('pdf')} disabled={!report || exporting !== null}><Printer size={16} aria-hidden="true" />PDF</button>
        <button type="button" className="icon-command" aria-label="刷新报告" title="刷新报告" onClick={() => void reload()} disabled={loading}><RefreshCw size={16} aria-hidden="true" /></button>
      </div>

      {error && report && (
        <div className="report-refresh-error" role="alert">
          <span>刷新失败，下面仍是上次成功读取的报告：{error}</span>
          <button type="button" className="secondary-inline" onClick={() => void reload()}>重试</button>
        </div>
      )}
      {error && !report && (
        <div className="panel empty-panel report-error" role="alert">
          <p>报告读取失败：{error}</p>
          <button type="button" className="secondary-inline" onClick={() => void reload()}>重试</button>
        </div>
      )}
      {loading && !report && <div className="panel report-loading" role="status">正在汇总{period.label}的用量…</div>}

      {report && (
        <>
          <section className="panel report-hero" aria-labelledby="report-title">
            <div className="report-hero-main">
              <span className="report-kicker">{period.shortLabel}{period.complete ? '' : ' · 进行中'} · {scope === 'cloud' ? '已同步账本' : '本机账本'}</span>
              <h2 id="report-title">{reportTitle(period)}</h2>
              <p className="report-compare">对比{period.previousLabel}（{period.previousStart.slice(5)} 至 {period.previousEnd.slice(5)}）</p>
              {report.highlights.length > 0 && (
                <ul className="report-highlights">
                  {report.highlights.map((line) => <li key={line}>{line}</li>)}
                </ul>
              )}
            </div>
            <div className="report-hero-number">
              <span className="report-label">有效 Token</span>
              <strong>{formatTokens(report.totals.effectiveTokens)}</strong>
              <DeltaBadge delta={report.deltas.tokens} />
              <span className="report-sub">活跃 {report.totals.activeDays} 天 · 输入 {formatTokens(report.totals.inputTokens)} · 输出 {formatTokens(report.totals.outputTokens)}</span>
            </div>
          </section>

          <div className="report-kpis">
            <div className="panel report-kpi"><span className="report-label">预估费用</span><strong>{cost(report.totals.cost, hideCosts)}</strong>{hideCosts ? <span className="report-delta">已隐藏</span> : <DeltaBadge delta={report.deltas.cost} />}</div>
            <div className="panel report-kpi"><span className="report-label">记录数</span><strong>{formatNum(report.totals.requests)}</strong><DeltaBadge delta={report.deltas.requests} /></div>
            <div className="panel report-kpi">
              <span className="report-label">缓存复用率</span>
              <strong>{percent(report.totals.cacheReuse)}</strong>
              <span className="report-delta" data-direction={report.deltas.cacheReusePoints === null ? 'flat' : report.deltas.cacheReusePoints >= 0 ? 'down' : 'up'}>
                {report.deltas.cacheReusePoints === null ? '缓存另列' : `${report.deltas.cacheReusePoints >= 0 ? '+' : '−'}${Math.abs(report.deltas.cacheReusePoints).toFixed(1)} 个百分点`}
              </span>
            </div>
            <div className="panel report-kpi">
              <span className="report-label">预算达成</span>
              <strong>{report.budgets.length === 0 ? '未设置' : `${report.budgets.filter((budget) => budget.level === 'ok').length} / ${report.budgets.length}`}</strong>
              <span className="report-delta">{report.budgets.length === 0 ? (scope === 'cloud' ? '预算只看本机账本' : `设置里可加${kind === 'week' ? '每周' : '每月'}预算`) : budgetSummary(report.budgets)}</span>
            </div>
          </div>

          <DayBars report={report} />

          <div className="report-grid">
            <Breakdown title="按 Agent" rows={report.agents} hideCosts={hideCosts} empty="本期没有用量" />
            <Breakdown title="按模型" rows={report.models} hideCosts={hideCosts} empty="本期没有用量" />
            <Breakdown title="按账号" rows={report.accounts} hideCosts={hideCosts} empty={scope === 'cloud' ? '账号维度只在本机账本里有' : '本期没有经网关的用量，账号维度不可得'} />
          </div>

          <div className="report-grid report-grid-2">
            <section className="panel report-card" aria-label="最贵的会话">
              <header className="report-card-header"><h2>最贵的会话</h2>{report.sessionsNote && <span>{report.sessionsNote}</span>}</header>
              {!report.sessions ? <p className="report-empty">{scope === 'cloud' ? '切到本机账本可查看会话排行' : '会话分析暂不可读'}</p>
                : report.sessions.length === 0 ? <p className="report-empty">本期没有带会话 ID 的记录</p> : (
                  <ol className="report-sessions">
                    {report.sessions.map((session, index) => (
                      <li key={session.id}>
                        <span className="report-session-rank">{index + 1}</span>
                        <div className="report-session-main">
                          <strong>{session.tool}{session.model ? ` · ${session.model}` : ''}</strong>
                          <span>{session.firstAt ? session.firstAt.slice(5, 16) : '时间未知'} · {formatNum(session.requests)} 条 · {formatTokens(session.tokens)}</span>
                        </div>
                        <span className="report-session-cost">{cost(session.cost, hideCosts)}</span>
                      </li>
                    ))}
                  </ol>
                )}
            </section>
            <section className="panel report-card" aria-label="预算与额度">
              <header className="report-card-header"><h2>预算与额度</h2><span>额度为当前读数</span></header>
              {report.budgets.length === 0 && report.quotas.length === 0 && <p className="report-empty">还没有设置预算，也没有可读的订阅额度</p>}
              {report.budgets.length > 0 && (
                <ul className="report-meters">
                  {report.budgets.map((budget) => (
                    <li key={budget.id} data-level={budget.level}>
                      <div className="report-rank-line">
                        <span className="report-rank-name">{budgetScopeName(budget.rule)} · {BUDGET_METRIC_LABELS[budget.rule.metric]}</span>
                        <span className="report-rank-value">{budget.percent === null ? '不可得' : budgetPercentText(budget, hideCosts)}</span>
                      </div>
                      {!(hideCosts && budget.rule.metric === 'cost') && <div className="report-rank-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, budget.percent ?? 0)}%` }} /></div>}
                      <div className="report-rank-meta">
                        <span>{budget.rule.metric === 'cost' ? `${cost(budget.used, hideCosts)} / ${cost(budget.rule.limit, hideCosts)}` : `${formatTokens(budget.used)} / ${formatTokens(budget.rule.limit)}`}</span>
                        <span>{{ ok: '达成', warn: '接近上限', over: '已超出', unavailable: '不可得' }[budget.level]}</span>
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
                        <span className="report-rank-value">{quota.stale ? '历史读数 · ' : ''}可用 {quota.remaining}%</span>
                      </div>
                      <div className="report-rank-bar" aria-hidden="true"><i style={{ width: `${Math.max(2, quota.remaining)}%` }} /></div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="panel report-card report-reminder" aria-label="自动生成">
            <BellRing size={18} aria-hidden="true" />
            <div>
              <strong>{kind === 'week' ? '每周一自动生成上周周报' : '每月 1 日自动生成上月月报'}</strong>
              <span>到点（9:00 起）发一条系统通知，通知只写期次和 Token 变化百分比，不含费用；打开这里即可查看并导出。</span>
            </div>
            <button
              type="button"
              role="switch"
              className="sf-switch"
              aria-label={kind === 'week' ? '每周一提醒' : '每月 1 日提醒'}
              aria-checked={remindOn}
              aria-busy={reminder.saving || undefined}
              disabled={reminder.saving || !reminder.loaded}
              title={reminder.loaded ? undefined : '提醒设置还没读到，暂不能修改'}
              onClick={() => void reminder.save(kind === 'week' ? { ...reminder.settings, weekly: !remindOn } : { ...reminder.settings, monthly: !remindOn })}
            />
          </section>
          <p className="report-footnote"><Download size={12} aria-hidden="true" /> 有效 Token = 输入 + 输出，缓存读写另列；预估费用按本机价格表估算。导出文件只含统计摘要，不含会话内容、项目名或设备标识。</p>
        </>
      )}
    </div>
  );
}

export default PeriodReportView;
