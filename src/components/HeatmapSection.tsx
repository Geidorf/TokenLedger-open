import { Activity } from 'lucide-react';
import type { CustomDateRange, RangeKey } from '../types';
import { formatEstimatedUsd, formatNum } from '../utils/format';
import type { SplitMetric } from '../utils/usageSplit';
import { heatmapCoverageNote, resolveHeatmapWindow, YearHeatmap, type HeatmapSnapshotCutoff } from './YearHeatmap';

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
  /** 日历画的是某一项、但单日明细不能按它筛选时的说明；此时调用方不传 onSelectDate。 */
  drillUnavailableNote?: string;
}

const METRIC_TITLE: Record<SplitMetric, string> = { tokens: ' Token 消耗日历', requests: '记录数日历', cost: '预估费用日历' };
const METRIC_FORMAT: Partial<Record<SplitMetric, (value: number) => string>> = {
  requests: (value) => `${formatNum(value)} 条记录`,
  cost: (value) => formatEstimatedUsd(value),
};

const LEGEND_LEVELS = [1, 2, 3, 4, 5] as const;

export function HeatmapSection({ heatmap, onSelectDate, range, customRange, timeContext, subject, subjectUnavailable, metric = 'tokens', metricFallback, drillUnavailableNote }: HeatmapSectionProps) {
  const { year, today, coverage } = resolveHeatmapWindow(range, customRange, timeContext);
  const coverageNote = heatmapCoverageNote(year, coverage, today);
  const baseTitle = range === 'custom' ? `${year} 年${METRIC_TITLE[metric]}` : `本年度${METRIC_TITLE[metric]}`;
  const title = subject ? `${subject} · ${baseTitle}` : baseTitle;
  const legendLabel = `色阶按本年已知日期的峰值相对着色，越深消耗越多；实心浅格为当天无用量${coverageNote ? '；斜纹格为未查询日期' : ''}`;

  return (
    <section className="panel heatmap-panel">
      <div className="heatmap-head">
        <div className="panel-title">
          <span className="panel-icon tone-success" aria-hidden="true"><Activity className="h-4 w-4" /></span>
          {title}
        </div>
        <div className="heat-legend" role="img" aria-label={legendLabel}>
          <span>少</span>
          <i className="heatmap-cell heat-0" title="当天无用量" />
          {LEGEND_LEVELS.map((level) => (
            <i key={level} className="heatmap-cell" data-level={level} title={`相对本年峰值第 ${level} 档`} />
          ))}
          <span>多</span>
          {coverageNote && (
            <>
              <i className="heatmap-cell heat-unknown" title="未查询" />
              <span>未查询</span>
            </>
          )}
        </div>
      </div>
      {coverageNote && <p className="heatmap-coverage">{coverageNote}</p>}
      {subjectUnavailable && <p className="heatmap-coverage">{subjectUnavailable} 没有逐日数据，这里显示全部用量。</p>}
      {metricFallback && <p className="heatmap-coverage">当前来源没有逐日的记录数与费用，这里显示有效 Token。</p>}
      {drillUnavailableNote && <p className="heatmap-coverage">{drillUnavailableNote}</p>}
      <YearHeatmap heatmap={heatmap} onSelectDate={onSelectDate} year={year} coverage={coverage} today={today} formatValue={METRIC_FORMAT[metric]} />
    </section>
  );
}

export default HeatmapSection;
