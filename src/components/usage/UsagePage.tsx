import type { ReactNode } from 'react';
import type { CustomDateRange, RangeKey, StatsData, Tab } from '../../types';
import { formatEstimatedUsd, formatTokens } from '../../utils/format';
import { rangeDisplayName } from '../../utils/rangeDisplay';
import { usageConclusion } from './usageSummary';
import './usage-page.css';

export type UsageSub = 'overview' | 'records' | 'sessions';

/** 内部 id 仍为 `sessions`，用户可见名称统一为「行为分析」（U-100）。侧栏二级入口共用这份定义。 */
export const USAGE_SUB_OPTIONS: { id: UsageSub; label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'records', label: '记录' },
  { id: 'sessions', label: '行为分析' },
];

const percent = (value: number | null) => (value === null ? '不可得' : `${(value * 100).toFixed(1)}%`);

function Conclusion({ stats, range, customRange }: { stats: StatsData; range: RangeKey; customRange: CustomDateRange | null }) {
  const conclusion = usageConclusion(stats);
  const delta = conclusion.deltaPercent;
  return (
    <p className="usage-conclusion" data-testid="usage-conclusion">
      {rangeDisplayName(range, customRange)}有效 Token <b>{formatTokens(conclusion.effectiveTokens)}</b>
      {conclusion.deltaDirection === 'new' && <>，上期同期无记录</>}
      {delta !== null && (
        <>，比上期同期 <b className={delta > 0 ? 'is-up' : ''}>{delta > 0 ? '+' : ''}{delta.toFixed(1)}%</b></>
      )}
      {conclusion.leadTool && <>；{conclusion.leadTool.name} 占 <b>{(conclusion.leadTool.share * 100).toFixed(0)}%</b></>}
      ；缓存复用率 <b>{percent(conclusion.cacheReuse)}</b>（缓存单列，不计入有效 Token）。
    </p>
  );
}

/** 顶栏面包屑与内容区可访问名称共用的子页名称（U-101）；非用量页返回 null。 */
export function usageSubLabelForTab(tab: Tab): string | null {
  const sub: UsageSub | null = tab === 'dashboard' ? 'overview' : tab === 'records' ? 'records' : tab === 'behavior' ? 'sessions' : null;
  return sub ? USAGE_SUB_OPTIONS.find((option) => option.id === sub)!.label : null;
}

export interface UsagePageProps {
  sub: UsageSub;
  stats: StatsData | null;
  range: RangeKey;
  customRange: CustomDateRange | null;
  /** 子页专属控件（T10.276）：渲染在面板第一行，与行为分析自带的范围栏同一位置。 */
  toolbar?: ReactNode;
  overview: ReactNode;
  records: ReactNode;
  sessions: ReactNode;
}

/**
 * 「用量」入口（U-89）：概览沿用原总览看板，行为分析子页沿用原行为分析（U-100），记录为逐请求列表。
 * 子页只由侧栏二级入口切换（U-101），页内没有子标签；内容区以子页名称作可访问名称，
 * 顶栏面包屑的子页部分对读屏隐藏，两处不重复朗读。
 */
export function UsagePage({ sub, stats, range, customRange, toolbar, overview, records, sessions }: UsagePageProps) {
  const label = USAGE_SUB_OPTIONS.find((option) => option.id === sub)!.label;
  return (
    <div className="usage-page">
      <h1 id="usage-panel-title" className="usage-page-title">{label}</h1>
      <section id="usage-panel" className="usage-panel" aria-labelledby="usage-panel-title" data-sub={sub}>
        {toolbar}
        {sub === 'overview' && stats && (
          <div className="usage-summary">
            <Conclusion stats={stats} range={range} customRange={customRange} />
            <span className="usage-cost" title="按本机价格表估算，未逐笔核价">
              <b>{formatEstimatedUsd(stats.summary.totalCost)}</b>预估费用
            </span>
          </div>
        )}
        {sub === 'overview' && overview}
        {sub === 'records' && records}
        {sub === 'sessions' && sessions}
      </section>
    </div>
  );
}
