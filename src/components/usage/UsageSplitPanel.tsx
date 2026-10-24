import { useId } from 'react';
import { Layers, LayoutDashboard, X } from 'lucide-react';
import type { StatsData } from '../../types';
import { useSegmentedIndicator } from '../../hooks/useSegmentedIndicator';
import { formatEstimatedUsd, formatNum, formatTokens } from '../../utils/format';
import {
  accountSplitAvailable,
  SPLIT_DIMENSIONS,
  SPLIT_DIMENSION_LABELS,
  SPLIT_METRICS,
  splitUsage,
  type SplitDimension,
  type SplitFocus,
  type SplitMetric,
} from '../../utils/usageSplit';
import { BrandIcon } from '../brand/BrandIcon';
import { localized, t, useLang } from '../../i18n';

export interface UsageSplitPanelProps {
  stats: StatsData;
  dimension: SplitDimension;
  metric: SplitMetric;
  focus: SplitFocus | null;
  /** 设备维度只在云端汇总、未按设备筛选且不止一台设备时可用（与原设备分布同一规则）。 */
  deviceAvailable: boolean;
  /** 跟随概览的 Token 口径：含缓存时 Token 指标加上缓存读写。 */
  showTotalTokens?: boolean;
  onDimensionChange: (dimension: SplitDimension) => void;
  onMetricChange: (metric: SplitMetric) => void;
  onFocusChange: (focus: SplitFocus | null) => void;
  /** Agent 与模型行旁的「看板」入口，打开原有专属看板。 */
  onOpenEntity?: (kind: 'tool' | 'model', id: string) => void;
}

const DIMENSION_LABEL = SPLIT_DIMENSION_LABELS;

const UNAVAILABLE_TITLE: Partial<Record<SplitDimension, string>> = localized({
  device: 'split.unavailable.device',
  account: 'split.unavailable.account',
});

function formatMetric(metric: SplitMetric, value: number | null): string {
  if (value === null) return t('split.na');
  if (metric === 'tokens') return formatTokens(value);
  if (metric === 'requests') return t('split.records', { n: formatNum(value) });
  return formatEstimatedUsd(value);
}

const percent = (value: number | null) => (value === null ? '' : `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`);

/**
 * 用量拆分（对齐 magpie 的 Split by）：同一份数据按 Agent、模型或设备拆，点一行即「只看这一项」，
 * 切到其他维度时列表随之收窄，热力图也跟着换成这一项的逐日用量（由概览接线）。
 */
export function UsageSplitPanel({
  stats,
  dimension,
  metric,
  focus,
  deviceAvailable,
  showTotalTokens = false,
  onDimensionChange,
  onMetricChange,
  onFocusChange,
  onOpenEntity,
}: UsageSplitPanelProps) {
  useLang();
  const titleId = useId();
  const dimensionRef = useSegmentedIndicator<HTMLDivElement>();
  const metricRef = useSegmentedIndicator<HTMLDivElement>();
  const result = splitUsage(stats, dimension, metric, focus, showTotalTokens);
  const accountAvailable = accountSplitAvailable(stats);
  const shownMetric = result.metrics.includes(metric) ? metric : 'tokens';
  const crossFocus = focus && focus.dimension !== dimension ? focus : null;

  return (
    <section className="panel usage-split" aria-labelledby={titleId}>
      <div className="usage-split-head">
        <div className="panel-title" id={titleId}>
          <span className="panel-icon tone-primary" aria-hidden="true"><Layers className="h-4 w-4" /></span>
          {t('split.title')}
        </div>
        <div ref={dimensionRef} className="segmented tl-seg" role="group" aria-label={t('split.dimAria')}>
          {SPLIT_DIMENSIONS.map(({ id, label }) => {
            const available = id === 'device' ? deviceAvailable : id === 'account' ? accountAvailable : true;
            return (
              <button
                key={id}
                type="button"
                className={dimension === id ? 'active' : ''}
                aria-pressed={dimension === id}
                disabled={!available}
                title={available ? t('split.byDim', { label }) : UNAVAILABLE_TITLE[id]}
                onClick={() => onDimensionChange(id)}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div ref={metricRef} className="segmented tl-seg" role="group" aria-label={t('split.metricAria')}>
          {SPLIT_METRICS.map(({ id, label }) => {
            const available = result.metrics.includes(id);
            return (
              <button
                key={id}
                type="button"
                className={shownMetric === id ? 'active' : ''}
                aria-pressed={shownMetric === id}
                disabled={!available}
                title={available ? t('split.sortBy', { label }) : t('split.crossOnlyTokens')}
                onClick={() => onMetricChange(id)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {focus && (
        <div className="usage-split-focus" role="status">
          <span>{t('split.focusOnly', { dim: DIMENSION_LABEL[focus.dimension] })} <b>{focus.id}</b></span>
          <button type="button" className="usage-btn" onClick={() => onFocusChange(null)}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            {t('split.showAll')}
          </button>
        </div>
      )}
      {result.focusIgnored && (
        <p className="usage-split-note">{t('split.stillAll', { reason: crossFocus?.dimension === 'account' || dimension === 'account' ? t('split.noCrossAccount') : t('split.noCrossDevice'), dim: DIMENSION_LABEL[dimension] })}</p>
      )}
      {dimension === 'account' && (
        <p className="usage-split-note">{t('split.accountNote')}</p>
      )}
      {crossFocus && !result.focusIgnored && (
        <p className="usage-split-note">{t('split.crossNote', { id: focus!.id, dim: DIMENSION_LABEL[dimension] })}</p>
      )}

      {result.rows.length === 0 ? (
        <p className="usage-split-note">{t('split.empty')}</p>
      ) : (
        <ol className="usage-split-list" aria-label={t('split.listAria', { dim: DIMENSION_LABEL[dimension], metric: SPLIT_METRICS.find((m) => m.id === shownMetric)!.label })}>
          {result.rows.map((row) => {
            const selected = focus?.dimension === dimension && focus.id === row.id;
            const details = [
              percent(row.share),
              row.cacheHit !== null ? t('split.cacheHit', { pct: (row.cacheHit * 100).toFixed(0) }) : '',
            ].filter(Boolean).join(' · ');
            return (
              <li key={row.id} className="usage-split-row">
                <button
                  type="button"
                  className="usage-split-pick"
                  aria-pressed={selected}
                  title={selected ? t('split.clickAgain') : t('split.onlyId', { id: row.id })}
                  onClick={() => onFocusChange(selected ? null : { dimension, id: row.id })}
                >
                  <span className="usage-split-name">
                    {(dimension === 'agent' || dimension === 'model') && <BrandIcon name={row.id} size={15} />}
                    <span>{row.id}</span>
                  </span>
                  <span className="usage-split-bar" aria-hidden="true">
                    <i style={{ width: `${Math.max(0, Math.min(1, row.share ?? 0)) * 100}%` }} />
                  </span>
                  <span className="usage-split-value">
                    <b>{formatMetric(shownMetric, row.value)}</b>
                    {details && <small>{details}</small>}
                  </span>
                </button>
                {onOpenEntity && (dimension === 'agent' || dimension === 'model') && (
                  <button
                    type="button"
                    className="usage-btn usage-split-open"
                    aria-label={t('split.openDashboard', { id: row.id })}
                    title={t('split.openDashboard', { id: row.id })}
                    onClick={() => onOpenEntity(dimension === 'agent' ? 'tool' : 'model', row.id)}
                  >
                    <LayoutDashboard className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
