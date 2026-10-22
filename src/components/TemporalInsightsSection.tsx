import { useId, useMemo } from 'react';
import type { ComponentProps } from 'react';
import type { TrendPoint, UsageComparison } from '../types';
import {
  buildRhythm,
  detectSpikes,
  type InsightTimeContext,
} from '../utils/insightRules';
import { AnomalySpikePanel } from './AnomalySpikePanel';
import { UsageRhythmPanel } from './UsageRhythmPanel';

interface TemporalInsightsSectionProps {
  trends: TrendPoint[];
  context: InsightTimeContext | null;
  /** 同期对比序列：小时桶时为分时段详情提供成本、请求与昨日同时段（T10.111）。 */
  comparison?: UsageComparison | null;
  onSelectDate?: (date: string) => void;
  /** 当前作用域做不了单日复盘时的说明，原样交给突增卡片（T10.158）。 */
  dateDrillUnavailable?: ComponentProps<typeof AnomalySpikePanel>['dateDrillUnavailable'];
}

/**
 * 时段洞察的唯一组合边界。标题与两个子项复用同一份派生结果，避免父组件
 * 猜测“可能有内容”后留下孤儿标题，也避免 UI 与 HTML 简报各自裁剪未来桶。
 */
export function TemporalInsightsSection({
  trends,
  context,
  comparison = null,
  onSelectDate,
  dateDrillUnavailable = null,
}: TemporalInsightsSectionProps) {
  const titleId = useId();
  const rhythm = useMemo(
    () => (context ? buildRhythm(trends, context, comparison) : null),
    [trends, context, comparison],
  );
  const detection = useMemo(
    () => (context ? detectSpikes(trends, context) : null),
    [trends, context],
  );

  if (!rhythm && !detection) return null;

  return (
    <section className="temporal-insights-group" aria-labelledby={titleId}>
      <h2 className="insight-group-title" id={titleId}>消费洞察 · 时段行为</h2>
      {rhythm && <UsageRhythmPanel rhythm={rhythm} />}
      {detection && (
        <AnomalySpikePanel detection={detection} onSelectDate={onSelectDate} dateDrillUnavailable={dateDrillUnavailable} />
      )}
    </section>
  );
}

export default TemporalInsightsSection;
