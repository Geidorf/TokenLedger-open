import { memo } from 'react';
import { Activity, AlertTriangle, ArrowRight, CalendarOff, CheckCircle2 } from 'lucide-react';
import type { DayDrillUnavailable } from '../hooks/useDayDrill';
import { formatTokens } from '../utils/format';
import type { Detection } from '../utils/insightRules';
import { InfoTip } from './InfoTip';
import '../styles/overviewDrill.css';
import { t, useLang } from '../i18n';

interface AnomalySpikePanelProps {
  detection: Detection;
  onSelectDate?: (date: string) => void;
  /** 当前作用域做不了单日复盘（如桌面云端）：日桶卡片不可点，就地写明原因，绝不跳到空结果。 */
  dateDrillUnavailable?: DayDrillUnavailable | null;
}

function AnomalySpikePanelComponent({ detection, onSelectDate, dateDrillUnavailable = null }: AnomalySpikePanelProps) {
  useLang();
  if (detection.state === 'empty') {
    return (
      <div className="anomaly-status-banner is-healthy" role="status">
        <Activity className="h-4 w-4 text-faint flex-none" />
        <span>{t('anomaly.empty')}</span>
      </div>
    );
  }

  if (detection.state === 'sparse') {
    return (
      <div className="anomaly-status-banner" role="status">
        <Activity className="h-4 w-4 text-tertiary flex-none" />
        <span>{t('anomaly.sparse', { n: detection.bucketCount })}</span>
      </div>
    );
  }

  if (detection.state === 'calm') {
    return (
      <div className="anomaly-status-banner is-healthy" role="status">
        <CheckCircle2 className="h-4 w-4 text-success flex-none" />
        <span>
          {t('anomaly.calm', { n: detection.bucketCount, ratio: detection.thresholdRatio })}
        </span>
      </div>
    );
  }

  const visible = detection.spikes.slice(0, 4);

  return (
    <section className="panel anomaly-spike-panel" aria-label={t('anomaly.title')}>
      <div className="panel-header">
        <div className="panel-title">
          <span className="panel-icon tone-danger" aria-hidden="true"><AlertTriangle className="h-4 w-4" /></span>
          <span>{t('anomaly.title')}</span>
          <span className="badge badge-danger ml-2">{t('anomaly.count', { n: detection.spikes.length })}</span>
          <InfoTip label={t('anomaly.rulesLabel')}>{t('anomaly.rules')}</InfoTip>
        </div>
      </div>

      <div className="anomaly-items-grid">
        {visible.map((spike) => {
          const drillBlocked = Boolean(spike.drillable && onSelectDate && dateDrillUnavailable);
          const isClickable = Boolean(spike.drillable && onSelectDate && !drillBlocked);
          const CardTag = isClickable ? 'button' : 'div';
          return (
            <CardTag
              key={spike.date}
              type={isClickable ? 'button' : undefined}
              className="anomaly-item-card"
              title={drillBlocked ? dateDrillUnavailable?.description : undefined}
              aria-label={isClickable
                ? t('anomaly.cardAria', { date: spike.date, tokens: formatTokens(spike.value), ratio: spike.ratio })
                : undefined}
              onClick={isClickable ? () => onSelectDate?.(spike.date) : undefined}
              onKeyDown={isClickable ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectDate?.(spike.date);
                }
              } : undefined}
            >
              <div className="anomaly-item-head">
                <span className="anomaly-date">{spike.label}</span>
                <span className="anomaly-ratio-badge">
                  <AlertTriangle className="h-3 w-3" />
                  {t('anomaly.ratio', { ratio: spike.ratio })}
                </span>
              </div>
              <div className="anomaly-item-value">
                {formatTokens(spike.value)} <span>Tokens</span>
              </div>
              {isClickable && (
                <div className="anomaly-item-action font-medium" aria-hidden="true">
                  {t('anomaly.viewDay')}
                  <ArrowRight className="h-3.5 w-3.5 ml-1" />
                </div>
              )}
              {drillBlocked && dateDrillUnavailable && (
                <div className="anomaly-item-action is-unavailable">
                  <CalendarOff className="h-3.5 w-3.5 mr-1 flex-none" aria-hidden="true" />
                  <span>{dateDrillUnavailable.label}</span>
                  <span className="sr-only">{t('anomaly.descSep')}{dateDrillUnavailable.description}</span>
                </div>
              )}
            </CardTag>
          );
        })}
        {detection.spikes.length > visible.length && (
          <div className="anomaly-item-card is-more">
            <div className="anomaly-date">{t('anomaly.more', { n: detection.spikes.length - visible.length })}</div>
          </div>
        )}
      </div>
    </section>
  );
}

export const AnomalySpikePanel = memo(AnomalySpikePanelComponent);
export default AnomalySpikePanel;
