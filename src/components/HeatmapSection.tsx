import { Activity } from 'lucide-react';
import type { CustomDateRange, RangeKey } from '../types';
import { formatEstimatedUsd, formatNum } from '../utils/format';
import type { SplitMetric } from '../utils/usageSplit';
import { heatmapCoverageNote, resolveHeatmapWindow, YearHeatmap, type HeatmapSnapshotCutoff } from './YearHeatmap';
import { t, useLang, type MessageKey } from '../i18n';

export interface HeatmapSectionProps {
  heatmap: Record<string, number>;
  onSelectDate?: (date: string) => void;
  /**
   * 全局范围与自定义区间：决定画哪一年、哪些日期算已查询。三项都必填（T10.161）：
   * 漏传会退回“画今年、整年都已查询”的旧语义，往年区间会重新画成空白的今年并出现伪 0。
   */
  range: RangeKey;
  customRange: CustomDateRange | null | undefined;
  /** 快照自己的查询截止点（`deriveInsightTimeContext`）；null = 无法确认，只有响应里有记录的日期算已知（GLB-01）。 */
  timeContext: HeatmapSnapshotCutoff | null;
  /** 用量拆分选中的 Agent 或模型：热力图画的是它自己的逐日用量，标题写明。 */
  subject?: string;
  /** 选中项没有逐日数据（设备，或来源不带实体热力图）：仍画整体，并说明原因。 */
  subjectUnavailable?: string;
  /** 画的指标（跟随用量拆分）；缺省 Token。 */
  metric?: SplitMetric;
  /** 所选的记录数或费用没有逐日数据，已退回 Token。 */
  metricFallback?: boolean;
}

const METRIC_TITLE: Record<SplitMetric, MessageKey> = { tokens: 'heatmap.title.tokens', requests: 'heatmap.title.requests', cost: 'heatmap.title.cost' };
const METRIC_YEAR_TITLE: Record<SplitMetric, MessageKey> = { tokens: 'heatmap.yearTitle.tokens', requests: 'heatmap.yearTitle.requests', cost: 'heatmap.yearTitle.cost' };
const METRIC_FORMAT: Partial<Record<SplitMetric, (value: number) => string>> = {
  requests: (value) => t('heatmap.records', { n: formatNum(value) }),
  cost: (value) => formatEstimatedUsd(value),
};

const LEGEND_LEVELS = [1, 2, 3, 4, 5] as const;

export function HeatmapSection({ heatmap, onSelectDate, range, customRange, timeContext, subject, subjectUnavailable, metric = 'tokens', metricFallback }: HeatmapSectionProps) {
  useLang();
  const { year, today, coverage } = resolveHeatmapWindow(range, customRange, timeContext);
  const coverageNote = heatmapCoverageNote(year, coverage, today);
  const baseTitle = range === 'custom' ? t(METRIC_YEAR_TITLE[metric], { year }) : t(METRIC_TITLE[metric]);
  const title = subject ? `${subject} · ${baseTitle}` : baseTitle;
  const legendLabel = t('heatmap.legend', { unknown: coverageNote ? t('heatmap.legendUnknown') : '' });

  return (
    <section className="panel heatmap-panel">
      <div className="heatmap-head">
        <div className="panel-title">
          <span className="panel-icon tone-success" aria-hidden="true"><Activity className="h-4 w-4" /></span>
          {title}
        </div>
        <div className="heat-legend" role="img" aria-label={legendLabel}>
          <span>{t('heatmap.less')}</span>
          <i className="heatmap-cell heat-0" title={t('heatmap.noUsage')} />
          {LEGEND_LEVELS.map((level) => (
            <i key={level} className="heatmap-cell" data-level={level} title={t('heatmap.level', { level })} />
          ))}
          <span>{t('heatmap.more')}</span>
          {coverageNote && (
            <>
              <i className="heatmap-cell heat-unknown" title={t('heatmap.notQueried')} />
              <span>{t('heatmap.notQueried')}</span>
            </>
          )}
        </div>
      </div>
      {coverageNote && <p className="heatmap-coverage">{coverageNote}</p>}
      {subjectUnavailable && <p className="heatmap-coverage">{t('heatmap.subjectUnavailable', { subject: subjectUnavailable })}</p>}
      {metricFallback && <p className="heatmap-coverage">{t('heatmap.metricFallback')}</p>}
      <YearHeatmap heatmap={heatmap} onSelectDate={onSelectDate} year={year} coverage={coverage} today={today} formatValue={METRIC_FORMAT[metric]} />
    </section>
  );
}

export default HeatmapSection;
