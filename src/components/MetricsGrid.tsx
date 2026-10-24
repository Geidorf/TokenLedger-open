import { formatCacheNetSavedUsd } from '../utils/cacheSavingsDisplay';
import { Activity, ArrowDownRight, ArrowUpRight, Banknote, MessagesSquare, Minus, Repeat2 } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { ComparisonDeltaMetric, DataScope, RangeKey, StatsData, Summary, UsageComparison } from '../types';
import { summaryEffectiveTokens } from '../types';
import { resolveCacheBreakdown, type CacheBreakdown } from '../utils/cacheDisplay';
import { calculateCacheEfficiency } from '../utils/frontendContracts';
import { formatEstimatedUsd, formatNum, formatTokens, formatUsdMagnitude, isKnownCost } from '../utils/format';
import { estimatedCostLabel, estimatedCostUnavailableReason } from '../utils/costCopy';
import { localized, t, useLang } from '../i18n';
import { parseCacheSavings } from '../utils/contracts/statsQuery';
import { comparisonClip } from '../utils/insightRules';
import { AnimatedNumber } from './AnimatedNumber';
import { CostHelpButton } from './CostHelpButton';

import { calculateIoRatio } from '../utils/workbuddyAnalytics';

interface MetricsGridProps {
  summary: Summary;
  showTotalTokens: boolean;
  /**
   * Stats v2 同期对比（T10.159，审计 Q3）。缺失时 KPI 不显示变化，绝不写成 0%；
   * 专属看板传实体自己的 comparison。
   */
  comparison?: UsageComparison | null;
  /**
   * 与 comparison 同一份响应的 meta 和当前范围（T10.159 P2-2），用来判断月末同期是否被截短：
   * 截短时主值统计到现在，变化只比到对齐日，变化后写明“截至 {日}”。不传就无从判断，不写说明。
   */
  meta?: StatsData['meta'];
  range?: RangeKey;
  /** 数据作用域：云端上期记录与 Token 均为 0 时无法证明真实为 0，只写“基线缺失”。 */
  scope?: DataScope;
}

/** KPI 卡上的同期变化：中性色、箭头加正负号，不用红绿表达好坏（T10.154 / T10.156 草案）。 */
export interface MetricChange {
  direction: 'up' | 'down' | 'flat' | null;
  /** 主文字：`+12%`、`新增`、`持平`、`基线缺失`。 */
  headline: string;
  /** 绝对变化：`+1.2M`、`−$3.20`；没有意义时为 null。 */
  absolute: string | null;
  /** 对比口径：`较上周同期` 等。 */
  period: string;
  /** 读屏与悬停用的完整句子。 */
  description: string;
}

interface MetricCard {
  /**
   * 稳定的卡片身份（T10.159 F8）：切换“含缓存”或缓存口径时标签会变，按标签作 key 会重建卡片、
   * 重播入场动画；按身份作 key 只更新文字与数值。
   */
  id: 'tokens' | 'cost' | 'requests' | 'cache';
  label: string;
  /** 补间用的原始数值；展示格式由 format 决定，中间帧先取整再格式化。 */
  rawValue: number;
  format: (value: number) => string;
  /** 唯一一行副标题（U-102）；空串时不画。 */
  sub: string;
  /** 副标题的完整说明，放进 title，不占可见行。 */
  subTitle?: string;
  icon: typeof Activity;
  /** 主 KPI（有效/总 Tokens）叠加品牌软渐变光晕 + primary 图标；其余卡中性底（DESIGN 5.4）。 */
  hero?: boolean;
  compactValue?: boolean;
  change?: MetricChange | null;
  /** 标签旁放「预估费用 ⓘ」帮助按钮（T10.154 §4.2）。 */
  help?: boolean;
  /** 输入占比（0–100），用于主 Token 卡底部的双色微缩比例条（T10.317）。 */
  inputSharePct?: number | null;
}

const formatWholeTokens = (value: number) => formatTokens(Math.round(value));
const formatWholeNumber = (value: number) => formatNum(Math.round(value));

const COMPARISON_PERIOD_LABELS = localized<UsageComparison['window']['kind']>({
  dayOverDay: 'metrics.vs.yesterday',
  weekOverWeek: 'metrics.vs.lastWeek',
  monthOverMonth: 'metrics.vs.lastMonth',
  periodOverPeriod: 'metrics.vs.previousRange',
});

/** 差值带符号，负号用 U+2212（T10.154 §4.1：差值带符号、不带 ≈）。 */
function signed(value: number, format: (absolute: number) => string): string {
  return `${value > 0 ? '+' : '−'}${format(Math.abs(value))}`;
}

/** |百分比| ≥ 10 取整，否则保留 1 位小数；正负号总是显示。 */
export function formatChangePercent(percent: number): string {
  const magnitude = Math.abs(percent);
  const text = magnitude >= 10 ? String(Math.round(magnitude)) : magnitude.toFixed(1);
  return `${percent > 0 ? '+' : '−'}${text}%`;
}

/**
 * 把一项同期差值变成 KPI 文案。上期为 0 时只写“新增”或“持平”，从不给百分比
 * （既不写 0%，也不写 ∞）；变化小于 0.05% 时写“持平”。
 */
export function describeMetricChange(
  delta: Pick<ComparisonDeltaMetric, 'absolute' | 'percent' | 'direction'>,
  formatAbsolute: (absolute: number) => string,
  period: string,
  subject: string,
): MetricChange {
  // Runtime comparison fields can be unavailable even when the main total is
  // known. Never turn a missing/non-finite difference into a proven zero.
  if (!Number.isFinite(delta.absolute) || !['up', 'down', 'flat', 'new'].includes(delta.direction)) {
    return incomparableChange(period, subject, t('metrics.changeUnavailable'));
  }
  const absolute = delta.absolute;
  if (delta.direction === 'new') {
    const text = absolute > 0 ? signed(absolute, formatAbsolute) : null;
    return {
      direction: 'up',
      headline: t('metrics.new'),
      absolute: text,
      period,
      description: text ? t('metrics.newDescAmount', { subject, period, amount: text }) : t('metrics.newDesc', { subject, period }),
    };
  }
  const percent = typeof delta.percent === 'number' && Number.isFinite(delta.percent) ? delta.percent : null;
  if (delta.direction === 'flat' || absolute === 0 || (percent !== null && Math.abs(percent) < 0.05)) {
    return { direction: 'flat', headline: t('metrics.flat'), absolute: null, period, description: t('metrics.flatDesc', { subject, period }) };
  }
  const direction = absolute > 0 ? 'up' : 'down';
  const absoluteText = signed(absolute, formatAbsolute);
  if (percent === null) {
    return { direction, headline: absoluteText, absolute: null, period, description: t('metrics.absoluteDesc', { subject, period, amount: absoluteText }) };
  }
  const percentText = formatChangePercent(percent);
  return {
    direction,
    headline: percentText,
    absolute: absoluteText,
    period,
    description: t(direction === 'up' ? 'metrics.upDesc' : 'metrics.downDesc', { subject, period, pct: percentText.slice(1), amount: absoluteText }),
  };
}

function incomparableChange(period: string, subject: string, reason: string): MetricChange {
  return { direction: null, headline: t('metrics.notComparable'), absolute: null, period, description: t('metrics.notComparableDesc', { subject, period, reason }) };
}

function baselineMissing(period: string, subject: string): MetricChange {
  return {
    direction: null,
    headline: t('trend.baselineMissing'),
    absolute: null,
    period,
    description: t('metrics.baselineMissingDesc', { subject }),
  };
}

/** 上期缓存必须与卡片主值同一种口径（读取量或合计量）才可比较。 */
function cacheDelta(
  cache: CacheBreakdown,
  comparison: UsageComparison,
): Pick<ComparisonDeltaMetric, 'absolute' | 'percent' | 'direction'> | null {
  const current = resolveCacheBreakdown(comparison.current.summary);
  const previous = resolveCacheBreakdown(comparison.previous.summary);
  let now: number;
  let before: number;
  if (cache.kind === 'split') {
    if (current.kind !== 'split' || previous.kind !== 'split') return null;
    now = current.read;
    before = previous.read;
  } else {
    now = current.total;
    before = previous.total;
  }
  if (!Number.isFinite(now) || !Number.isFinite(before) || now < 0 || before < 0) return null;
  const absolute = now - before;
  return {
    absolute,
    percent: before === 0 ? null : (absolute / before) * 100,
    direction: before === 0 ? (now > 0 ? 'new' : 'flat') : absolute === 0 ? 'flat' : absolute > 0 ? 'up' : 'down',
  };
}

/**
 * KPI 永不换行（DESIGN §4.4）：按最终字符串长度降字号，而不是让 ≈$1,422.78 折成两行。
 * 阈值按 tabular-nums 在 4 列布局里的实测宽度定：9 字符起降到 24px，11 字符起 20px，13 字符起 17px。
 */
export function metricValueSizeClass(text: string): '' | ' is-long' | ' is-longer' | ' is-longest' {
  const length = Array.from(text).length;
  if (length >= 13) return ' is-longest';
  if (length >= 11) return ' is-longer';
  if (length >= 9) return ' is-long';
  return '';
}

// U-102：比较窗口（如「较昨日同期」）四张卡都一样，平时只留在 title 与读屏句里；
// 同期被截短时（T10.159 P2-2）窗口和主值不一致，才在卡面写出「截至 …」。
function ChangeLine({ change, showPeriod }: { change: MetricChange; showPeriod: boolean }) {
  const Icon = change.direction === 'up' ? ArrowUpRight : change.direction === 'down' ? ArrowDownRight : Minus;
  return (
    <div className="metric-change mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs leading-snug text-secondary" title={change.description}>
      <span className="sr-only">{change.description}</span>
      <span className="inline-flex items-center gap-0.5 font-semibold tabular-nums" aria-hidden="true">
        {change.direction !== null && <Icon className="h-3 w-3" />}
        {change.headline}
        {change.absolute && <span className="font-medium">· {change.absolute}</span>}
      </span>
      {showPeriod && <span className="text-tertiary" aria-hidden="true">{change.period}</span>}
    </div>
  );
}

export function MetricsGrid(props: MetricsGridProps) {
  // 只为在切换界面语言时重绘；卡片内容在 MetricsGridView 里算。
  useLang();
  return <MetricsGridView {...props} />;
}

export function MetricsGridView({ summary, showTotalTokens, comparison, meta, range, scope }: MetricsGridProps) {
  const effective = summaryEffectiveTokens(summary);
  const total = effective + (summary.cachedTokens || 0);

  const avgVal = summary.totalRequests > 0
    ? Math.round((showTotalTokens ? total : effective) / summary.totalRequests)
    : 0;

  const cache = resolveCacheBreakdown(summary);
  const cacheEfficiency = calculateCacheEfficiency(summary);
  const cacheSavings = parseCacheSavings(summary.cacheSavings, summary);
  const provenCacheSavings = cacheSavings?.netSavedUsd ?? null;
  const costKnown = isKnownCost(summary.totalCost);
  const ioRatio = calculateIoRatio(summary.inputTokens, summary.outputTokens);

  // 同期变化只来自 comparison.delta（有效 Token、请求、费用）；缺 comparison 时整行不画。
  // 云端上期记录与 Token 均为 0 无法证明是真实的 0，统一写“基线缺失”。scope 未知且上期
  // 为空时同样不能证明，宁可不显示。
  // 月末同期截短时（P2-2）变化与主值不是同一个窗口：对比口径后写明“截至 {对齐日}”，读屏句同样带上。
  const clip = comparison && range ? comparisonClip({ comparison, meta }, range) : null;
  const period = comparison
    ? `${COMPARISON_PERIOD_LABELS[comparison.window.kind] ?? t('metrics.vs.previous')}${clip ? t('metrics.clipSuffix', { note: clip.note }) : ''}`
    : '';
  const previousEmpty = !!comparison
    && comparison.previous.summary.totalRequests === 0
    && comparison.previous.summary.totalTokens === 0;
  const baselineUnverified = previousEmpty && scope === 'cloud';
  const changesHidden = !comparison || (previousEmpty && scope === undefined);
  const changeFor = (
    delta: Pick<ComparisonDeltaMetric, 'absolute' | 'percent' | 'direction'> | null | undefined,
    formatAbsolute: (absolute: number) => string,
    subject: string,
    comparable = true,
  ): MetricChange | null => {
    if (changesHidden || !delta) return null;
    if (baselineUnverified) return baselineMissing(period, subject);
    if (!comparable) return incomparableChange(period, subject, t('metrics.costIncomparable'));
    return describeMetricChange(delta, formatAbsolute, period, subject);
  };
  // “含缓存”口径下主值是总 Token，但变化仍是有效 Token 的变化，标签写明“有效”。
  const tokenChange = changeFor(comparison?.delta.tokens, formatTokens, t('trend.seriesTokens'));
  const tokenCardChange = tokenChange && showTotalTokens && tokenChange.direction !== null
    ? { ...tokenChange, headline: t('metrics.effectiveHeadline', { headline: tokenChange.headline }) }
    : tokenChange;
  // 云端上期缓存拆分尚未实测验证（T10.156 草案 §2.4），缓存变化先只在本机显示。
  const cacheChange = scope === 'local' && comparison
    ? changeFor(cacheDelta(cache, comparison), formatTokens, t(cache.kind === 'split' ? 'metrics.cacheRead' : 'metrics.cache'))
    : null;

  const cards: MetricCard[] = [
    {
      id: 'tokens',
      label: t(showTotalTokens ? 'metrics.totalTokens' : 'trend.seriesTokens'),
      rawValue: showTotalTokens ? total : effective,
      format: formatWholeTokens,
      sub: showTotalTokens
        ? t('metrics.ioCache', { input: formatTokens(summary.inputTokens), output: formatTokens(summary.outputTokens), cache: formatTokens(summary.cachedTokens) })
        : t('metrics.io', { input: formatTokens(summary.inputTokens), output: formatTokens(summary.outputTokens) }),
      subTitle: showTotalTokens ? undefined : t('metrics.ioRatio', { ratio: ioRatio }),
      icon: Activity,
      hero: true,
      change: tokenCardChange,
      inputSharePct: effective > 0 ? Math.max(4, Math.min(96, Math.round(((summary.inputTokens || 0) / effective) * 100))) : null,
    },
    {
      // T10.154 §4.3：总额不可得时主值写「不可得」（不补间、不画 $0），副行给原因；
      // 可得时「按价格表估算，非账单」只在 ⓘ 里说（U-102），副行留空。
      id: 'cost',
      label: estimatedCostLabel(),
      rawValue: costKnown ? summary.totalCost : Number.NaN,
      format: formatEstimatedUsd,
      sub: costKnown ? '' : estimatedCostUnavailableReason(),
      icon: Banknote,
      compactValue: true,
      help: true,
      change: costKnown ? changeFor(
        comparison?.delta.cost, formatUsdMagnitude, estimatedCostLabel(),
        !!comparison && isKnownCost(comparison.current.summary.totalCost) && isKnownCost(comparison.previous.summary.totalCost),
      ) : null,
    },
    {
      id: 'requests',
      label: t('metrics.records'),
      rawValue: summary.totalRequests,
      format: formatWholeNumber,
      // 总览只有一种日均（T10.159 P3-1）：趋势卡按已完成的日子计算；这里不再给含进行中今天的“活跃日均”。
      sub: t('metrics.perRecord', { tokens: formatTokens(avgVal) }),
      icon: MessagesSquare,
      change: changeFor(comparison?.delta.requests, formatNum, t('metrics.records')),
    },
    {
      id: 'cache',
      label: t(cache.kind === 'split' ? 'metrics.cacheRead' : 'metrics.cache'),
      rawValue: cache.kind === 'split' ? cache.read : cache.total,
      format: formatWholeTokens,
      sub: cache.kind === 'split'
        ? (provenCacheSavings !== null
          ? `${t('metrics.cacheNetSaved', { amount: formatCacheNetSavedUsd(provenCacheSavings) })}${cacheSavings && (cacheSavings.fallbackPricedReadTokens > 0 || cacheSavings.fallbackPricedWriteTokens > 0) ? t('metrics.fallbackPriced') : ''}`
          : t('metrics.cacheNetSavedUnavailable'))
        : t('metrics.cacheTotalOnly'),
      subTitle: cache.kind === 'split' && provenCacheSavings !== null
        ? `${t('metrics.reuseRate', { pct: cacheEfficiency.kind === 'split' ? cacheEfficiency.cacheRatioPercent : 0 })}${provenCacheSavings < 0 ? t('metrics.writePremium') : ''}${cacheSavings && (cacheSavings.fallbackPricedReadTokens > 0 || cacheSavings.fallbackPricedWriteTokens > 0) ? t('metrics.fallbackTokens', { read: formatTokens(cacheSavings.fallbackPricedReadTokens), write: formatTokens(cacheSavings.fallbackPricedWriteTokens) }) : ''}`
        : undefined,
      icon: Repeat2,
      change: cacheChange,
    },
  ];

  return (
    <div className="metrics-grid" role="region" aria-label={t('metrics.aria')}>
      {cards.map((card, index) => (
        <div
          key={card.id}
          className={`metric-card${card.hero ? ' is-hero' : ''}${card.compactValue ? ' has-compact-value' : ''}`}
          style={{ '--stagger-index': index } as CSSProperties}
        >
          <div className="metric-icon" aria-hidden="true">
            <card.icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            {card.help ? (
              <div className="metric-label-row">
                <div className="metric-label">{card.label}</div>
                <CostHelpButton scope={scope} />
              </div>
            ) : <div className="metric-label">{card.label}</div>}
            <div className={`metric-value num${metricValueSizeClass(card.format(card.rawValue))}`}>
              <AnimatedNumber value={card.rawValue} format={card.format} />
            </div>
            {card.change && <ChangeLine change={card.change} showPeriod={!!clip} />}
            {card.sub && (
              <div className="metric-sub" title={card.subTitle ? `${card.sub} · ${card.subTitle}` : card.sub}>
                {card.sub}
              </div>
            )}
            {card.inputSharePct !== null && card.inputSharePct !== undefined && (
              <div className="metric-io-bar" aria-hidden="true">
                <span className="metric-io-in" style={{ width: `${card.inputSharePct}%` }} />
                <span className="metric-io-out" style={{ width: `${100 - card.inputSharePct}%` }} />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export default MetricsGrid;
