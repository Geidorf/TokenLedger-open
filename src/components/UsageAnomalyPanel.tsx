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
  const copy = describeFinding(finding, today);
  const drill = onSelectDate ? findingDrill(finding) : null;
  const body = (
    <>
      <div className="anomaly-item-head">
        <span className="anomaly-date">{copy.title}</span>
        <span className="usage-anomaly-when">{copy.when}</span>
      </div>
      <div className="anomaly-item-value">{copy.value}</div>
      <div className="usage-anomaly-comparison">{copy.comparison}</div>
      {finding.kind === 'expensiveSession' && finding.subject && (
        <div className="usage-anomaly-subject" title={finding.subject}>会话 {finding.subject.slice(0, 12)}</div>
      )}
      {drill && (
        <div className="anomaly-item-action font-medium" aria-hidden="true">
          查看当日调用明细
          <ArrowRight className="h-3.5 w-3.5 ml-1" />
        </div>
      )}
    </>
  );
  if (!drill || !onSelectDate) return <div className="anomaly-item-card usage-anomaly-card">{body}</div>;
  return (
    <button
      type="button"
      className="anomaly-item-card usage-anomaly-card"
      aria-label={`${copy.title}，${copy.when}，${copy.value}，${copy.comparison}。点击查看当日明细`}
      onClick={() => onSelectDate(drill.date, drill.tools.length || drill.models.length
        ? { tools: drill.tools, models: drill.models }
        : undefined)}
    >
      {body}
    </button>
  );
}

export function UsageAnomalyView({ report, error, notify, notifySaving, notifyError, onNotifyChange, onSelectDate, today }: UsageAnomalyViewProps) {
  const [expanded, setExpanded] = useState(false);
  const titleId = useId();
  const notifyId = useId();
  const findings = report?.findings ?? [];
  const visible = expanded ? findings : findings.slice(0, VISIBLE_FINDINGS);
  const skipped = (report?.checks ?? []).filter((check) => check.state !== 'evaluated');
  const ruleTip = (
    <InfoTip label="异常判定规则">
      <span className="usage-anomaly-rules">
        只看本机已经发生的用量，不做预测。
        {ANOMALY_KINDS.map((kind) => (
          <span key={kind}><strong>{KIND_LABELS[kind]}</strong>：{RULE_TEXT[kind]}</span>
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
          <span>用量异常</span>
          {findings.length > 0 && <span className="badge badge-warning ml-2">{findings.length} 项</span>}
          {ruleTip}
        </div>
        <div className="usage-anomaly-notify">
          <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
          <span id={notifyId}>异常时系统通知</span>
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

      {error && !report ? (
        <div className="anomaly-status-banner" role="status">
          <Activity className="h-4 w-4 text-tertiary flex-none" />
          <span>{error}</span>
        </div>
      ) : !report ? (
        <div className="anomaly-status-banner" role="status">
          <Activity className="h-4 w-4 text-tertiary flex-none" />
          <span>正在检查最近的用量…</span>
        </div>
      ) : findings.length === 0 ? (
        <div className="anomaly-status-banner is-healthy" role="status">
          <CheckCircle2 className="h-4 w-4 text-success flex-none" />
          <span>最近 {report.recentHours} 小时与 {report.recentDays} 天没有发现异常（与此前 {report.baselineDays} 天比较）。</span>
        </div>
      ) : (
        <div className="anomaly-items-grid">
          {visible.map((finding) => (
            <FindingCard key={finding.id} finding={finding} today={today} onSelectDate={onSelectDate} />
          ))}
          {findings.length > visible.length && (
            <button type="button" className="anomaly-item-card is-more" onClick={() => setExpanded(true)}>
              <span className="anomaly-date">再显示 {findings.length - visible.length} 项</span>
            </button>
          )}
        </div>
      )}

      {report && skipped.length > 0 && (
        <p className="usage-anomaly-note">
          {skipped.map((check) => `${KIND_LABELS[check.kind]}：${CHECK_STATE_TEXT[check.state as Exclude<typeof check.state, 'evaluated'>]}`).join('；')}
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
