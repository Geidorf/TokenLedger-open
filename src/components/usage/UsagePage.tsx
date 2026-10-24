import type { ReactNode } from 'react';
import type { CustomDateRange, RangeKey, StatsData, Tab } from '../../types';
import { formatEstimatedUsd, formatTokens } from '../../utils/format';
import { rangeDisplayName } from '../../utils/rangeDisplay';
import { usageConclusion } from './usageSummary';
import './usage-page.css';
import { t } from '../../i18n';

export type UsageSub = 'overview' | 'requests' | 'sessions' | 'allowances';

/**
 * 用量子页对齐 magpie Usage 页（概览 / 请求 / 会话），额度单列一页：
 * 原「记录」与一级入口「活动明细」合并为「请求」，原「行为分析」改名「会话」。
 * magpie 的 Context 需要逐请求的提示词构成，本机与云端都没有这份数据，暂不设入口。
 * 侧栏二级入口共用这份定义。
 */
export const USAGE_SUB_OPTIONS: { id: UsageSub; label: string }[] = [
  { id: 'overview', get label() { return t('usage.sub.overview'); } },
  { id: 'requests', get label() { return t('usage.sub.requests'); } },
  { id: 'sessions', get label() { return t('usage.sub.sessions'); } },
  { id: 'allowances', get label() { return t('usage.sub.allowances'); } },
];

const USAGE_SUB_BY_TAB: Partial<Record<Tab, UsageSub>> = {
  dashboard: 'overview',
  logs: 'requests',
  behavior: 'sessions',
  allowances: 'allowances',
};

/** 用量 Tab → 子页；非用量页返回 null。 */
export function usageSubForTab(tab: Tab): UsageSub | null {
  return USAGE_SUB_BY_TAB[tab] ?? null;
}

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
  const sub = usageSubForTab(tab);
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
  requests: ReactNode;
  sessions: ReactNode;
  allowances: ReactNode;
}

/**
 * 「用量」入口（U-89）：概览沿用原总览看板，请求为可筛选的逐请求明细，会话沿用原行为分析，额度为订阅额度详情。
 * 子页只由侧栏二级入口切换（U-101），页内没有子标签；内容区以子页名称作可访问名称，
 * 顶栏面包屑的子页部分对读屏隐藏，两处不重复朗读。
 */
export function UsagePage({ sub, stats, range, customRange, toolbar, overview, requests, sessions, allowances }: UsagePageProps) {
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
        {sub === 'requests' && requests}
        {sub === 'sessions' && sessions}
        {sub === 'allowances' && allowances}
      </section>
    </div>
  );
}
