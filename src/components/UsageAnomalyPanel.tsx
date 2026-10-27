import { memo, useId, useState } from 'react';
import { Activity, ArrowRight, BellRing, CheckCircle2, ShieldAlert } from 'lucide-react';
import { useUsageAnomalies, useUsageAnomalySettings } from '../hooks/useUsageAnomalies';
import {
  ANOMALY_KINDS,
  CHECK_STATE_TEXT,
  KIND_LABELS,
  RULE_TEXT,
  describeFinding,
  findingDrill,
  type AnomalyFinding,
  type AnomalyReport,
} from '../utils/usageAnomaly';
import { InfoTip } from './InfoTip';
import { useT } from '../i18n';
import { isRealSessionId, openSessionDetail } from '../features/sessionDetail/sessionDetailRoute';
import '../styles/usageAnomaly.css';

const VISIBLE_FINDINGS = 6;

interface UsageAnomalyPanelProps {
  onSelectDate?: (date: string, entity?: { tools: string[]; models: string[] }) => void;
}

interface UsageAnomalyViewProps extends UsageAnomalyPanelProps {
  report: AnomalyReport | null;
  error: string;
  notify: boolean;
  notifySaving: boolean;
  notifyError: string;
  onNotifyChange: (notify: boolean) => void;
  today?: Date;
}

function FindingCard({ finding, today, onSelectDate }: { finding: AnomalyFinding; today?: Date; onSelectDate?: UsageAnomalyPanelProps['onSelectDate'] }) {
  const t = useT();
  const copy = describeFinding(finding, today);
  const aria = { title: copy.title, when: copy.when, value: copy.value, comparison: copy.comparison };
  const drill = onSelectDate ? findingDrill(finding) : null;
  // 昂贵会话没有单日下钻，改为打开这个会话的详情。
  const session = finding.kind === 'expensiveSession' && isRealSessionId(finding.subject) ? finding.subject : null;
  const body = (
    <>
      <div className="anomaly-item-head">
        <span className="anomaly-date">{copy.title}</span>
        <span className="usage-anomaly-when">{copy.when}</span>
      </div>
      <div className="anomaly-item-value">{copy.value}</div>
      <div className="usage-anomaly-comparison">{copy.comparison}</div>
      {finding.kind === 'expensiveSession' && finding.subject && (
        <div className="usage-anomaly-subject" title={finding.subject}>{t('usageAnomaly.session', { id: finding.subject.slice(0, 12) })}</div>
      )}
      {(drill || session) && (
        <div className="anomaly-item-action font-medium" aria-hidden="true">
          {t(session ? 'usageAnomaly.action.viewSession' : 'usageAnomaly.action.viewDay')}
          <ArrowRight className="h-3.5 w-3.5 ml-1" />
        </div>
      )}
    </>
  );
  if (session) {
    return (
      <button
        type="button"
        className="anomaly-item-card usage-anomaly-card"
        aria-label={t('usageAnomaly.aria.session', aria)}
        onClick={() => openSessionDetail({ sessionId: session, tool: finding.tool })}
      >
        {body}
      </button>
    );
  }
  if (!drill || !onSelectDate) return <div className="anomaly-item-card usage-anomaly-card">{body}</div>;
  return (
    <button
      type="button"
      className="anomaly-item-card usage-anomaly-card"
      aria-label={t('usageAnomaly.aria.day', aria)}
      onClick={() => onSelectDate(drill.date, drill.tools.length || drill.models.length
        ? { tools: drill.tools, models: drill.models }
        : undefined)}
    >
      {body}
    </button>
  );
}

export function UsageAnomalyView({ report, error, notify, notifySaving, notifyError, onNotifyChange, onSelectDate, today }: UsageAnomalyViewProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const titleId = useId();
  const notifyId = useId();
  const findings = report?.findings ?? [];
  const visible = expanded ? findings : findings.slice(0, VISIBLE_FINDINGS);
  const skipped = (report?.checks ?? []).filter((check) => check.state !== 'evaluated');
  const ruleTip = (
    <InfoTip label={t('usageAnomaly.rules.label')}>
      <span className="usage-anomaly-rules">
        {t('usageAnomaly.rules.intro')}
        {ANOMALY_KINDS.map((kind) => (
          <span key={kind}><strong>{KIND_LABELS[kind]}</strong>{t('usageAnomaly.rules.separator')}{RULE_TEXT[kind]}</span>
        ))}
      </span>
    </InfoTip>
  );

  return (
    <section className="panel usage-anomaly-panel" aria-labelledby={titleId}>
      <div className="panel-header">
        <div className="panel-title" id={titleId}>
          <span className={`panel-icon ${findings.length ? 'tone-warning' : 'tone-success'}`} aria-hidden="true">
            <ShieldAlert className="h-4 w-4" />
          </span>
          <span>{t('usageAnomaly.title')}</span>
          {findings.length > 0 && <span className="badge badge-warning ml-2">{t('usageAnomaly.count', { n: findings.length })}</span>}
          {ruleTip}
        </div>
        <div className="usage-anomaly-notify">
          <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
          <span id={notifyId}>{t('usageAnomaly.notify.label')}</span>
          <button
            type="button"
            role="switch"
            className={`sf-switch${notifySaving ? ' is-busy' : ''}`}
            aria-labelledby={notifyId}
            aria-checked={notify}
            aria-busy={notifySaving || undefined}
            disabled={notifySaving}
            onClick={() => onNotifyChange(!notify)}
          />
        </div>
      </div>
      {notifyError && <p className="usage-anomaly-note is-error" role="alert">{notifyError}</p>}

      {error && report && (
        <p className="usage-anomaly-note is-error" role="alert">{t('usageAnomaly.status.stale')}</p>
      )}
      {error && !report ? (
        <div className="anomaly-status-banner" role="status">
          <Activity className="h-4 w-4 text-tertiary flex-none" />
          <span>{error}</span>
        </div>
      ) : !report ? (
        <div className="anomaly-status-banner" role="status">
          <Activity className="h-4 w-4 text-tertiary flex-none" />
          <span>{t('usageAnomaly.status.loading')}</span>
        </div>
      ) : findings.length === 0 ? (
        <div className={`anomaly-status-banner${error ? '' : ' is-healthy'}`} role="status">
          <CheckCircle2 className="h-4 w-4 text-success flex-none" />
          <span>{t('usageAnomaly.status.clean', { hours: report.recentHours, days: report.recentDays, baselineDays: report.baselineDays })}</span>
        </div>
      ) : (
        <div className="anomaly-items-grid">
          {visible.map((finding) => (
            <FindingCard key={finding.id} finding={finding} today={today} onSelectDate={onSelectDate} />
          ))}
          {findings.length > visible.length && (
            <button type="button" className="anomaly-item-card is-more" onClick={() => setExpanded(true)}>
              <span className="anomaly-date">{t('usageAnomaly.more', { n: findings.length - visible.length })}</span>
            </button>
          )}
        </div>
      )}

      {report && skipped.length > 0 && (
        <p className="usage-anomaly-note">
          {skipped.map((check) => t('usageAnomaly.check.entry', {
            kind: KIND_LABELS[check.kind],
            state: CHECK_STATE_TEXT[check.state as Exclude<typeof check.state, 'evaluated'>],
          })).join(t('usageAnomaly.check.separator'))}
        </p>
      )}
    </section>
  );
}

/** 概览「消费洞察」里的用量异常卡片；只在本机范围出现。 */
function UsageAnomalyPanelComponent({ onSelectDate }: UsageAnomalyPanelProps) {
  const { report, error } = useUsageAnomalies(true);
  const settings = useUsageAnomalySettings(true);
  return (
    <UsageAnomalyView
      report={report}
      error={error}
      notify={settings.settings.notify}
      notifySaving={settings.saving}
      notifyError={settings.error}
      onNotifyChange={(notify) => void settings.save({ notify })}
      onSelectDate={onSelectDate}
    />
  );
}

export const UsageAnomalyPanel = memo(UsageAnomalyPanelComponent);
export default UsageAnomalyPanel;
