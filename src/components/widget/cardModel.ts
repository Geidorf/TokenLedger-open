import type { StatsData, ToolStat, UsageComparison } from '../../types';
import { effectiveTokens, summaryEffectiveTokens, toolColorMap } from '../../types';
import { formatEstimatedUsd, formatNum, formatTokens } from '../../utils/format';
import { toolDisplayName } from '../../utils/toolDisplayName';
import { comparisonClip } from '../../utils/insightRules';
import type { QuotaLevel, QuotaWindowHighlight } from '../../utils/quotaOverview';
import { WIDGET_RANGES, selectWidgetQuota, type WidgetLayout, type WidgetRange, type WidgetSurface } from '../../utils/widgetConfig';
import { describeMetricChange, type MetricChange } from '../MetricsGrid';

/**
 * 「账本圆环」卡片的显示模型（T10.192，方案 §5.2、§6.3、§6.4）。
 *
 * 托盘挂件、桌面小组件与设置页预览共用四种板式；板式只认这里算好的文字与数值，不自己读统计。
 * 读不到的值在这里就变成「—」或「不可得」，板式里没有把未知画成 0 的分支（GLB-01）。
 */

export type CardTheme = 'light' | 'dark';

/** 额度档位的三个字。数字本身不染色，档位由环色和这三个字表达（方案 §6.3）。 */
export const TIER_WORDS: Record<QuotaLevel, string> = { ok: '充足', warn: '偏紧', critical: '告急' };

/**
 * 方案 §6.4 的窗口尺寸（逻辑像素）。窗口本身由 T10.193 按这张表建窗与改尺寸；
 * 这里给设置页预览与浏览器走查用。托盘挂件 = 桌面小组件 + 26px 顶栏。
 */
export const TRAY_BAR_EXTRA = 26;
const DESKTOP_HEIGHTS: Record<WidgetLayout, number> = { usage: 388, combo: 172, quota: 272, compact: 104, routing: 300, panel: 560 };
export const WIDGET_CARD_WIDTH = 364;

export function widgetCardSize(surface: WidgetSurface, layout: WidgetLayout): { width: number; height: number } {
  return {
    width: WIDGET_CARD_WIDTH,
    height: DESKTOP_HEIGHTS[layout] + (surface === 'popover' ? TRAY_BAR_EXTRA : 0),
  };
}

/** 「额度总览」最多画的圆环数；再多写「+N」，不滚动。 */
export const QUOTA_OVERVIEW_LIMIT = 6;

// ── 较昨日同期 ────────────────────────────────────────────────────────────────

/** 与看板 KPI（`MetricsGrid` 的 `COMPARISON_PERIOD_LABELS`）同一组说法。 */
const PERIOD_LABELS: Record<UsageComparison['window']['kind'], string> = {
  dayOverDay: '较昨日同期',
  weekOverWeek: '较上周同期',
  monthOverMonth: '较上月同期',
  periodOverPeriod: '较上一同长区间',
};

/**
 * 胶囊里的同期变化，与看板 KPI「较昨日同期」同一来源、同一写法：`comparison.delta.tokens`
 * （有效 Token，本期与上期截到同一进度）经 `describeMetricChange` 生成；月末同期被截短时
 * 对比口径后写明「截至 {日}」（`comparisonClip`）。挂件只读本机，与看板本机口径一样：
 * 上期为 0 写「新增」或「持平」，没有 comparison 就不画胶囊，绝不写 0%。
 */
export function describeWidgetChange(
  stats: Pick<StatsData, 'comparison' | 'meta'>,
  range: WidgetRange,
): MetricChange | null {
  const comparison = stats.comparison;
  if (!comparison) return null;
  const clip = comparisonClip({ comparison, meta: stats.meta }, range);
  const period = `${PERIOD_LABELS[comparison.window.kind] ?? '较上期同期'}${clip ? `（${clip.note}）` : ''}`;
  return describeMetricChange(comparison.delta.tokens, formatTokens, period, '有效 Token');
}

// ── 走势 ──────────────────────────────────────────────────────────────────────

export interface CardTrendTick {
  /** 0–1，占整条横轴的比例。 */
  at: number;
  label: string;
  anchor: 'start' | 'middle' | 'end';
}

export interface CardTrend {
  bucket: 'hour' | 'day';
  /** 横轴一共多少个桶：今日 24 小时、本周 7 天、本月按当月天数；走势只画到当前进度。 */
  slots: number;
  current: number[];
  /** 上期同进度的同长序列（契约：两段稠密桶，同长同序）。 */
  previous: number[];
  labels: string[];
  ticks: CardTrendTick[];
  /** 「昨日同期」「上周同期」「上月同期」。 */
  previousLabel: string;
  /** 本期窗口起止，用来把进行中的最后一桶画在“现在”。 */
  window: { currentStart?: string; currentEnd?: string };
}

const WEEKDAY_TICKS = ['一', '二', '三', '四', '五', '六', '日'];

function daysInMonthOf(bucket: string | undefined): number | null {
  const match = bucket ? /^(\d{4})-(\d{2})-\d{2}$/.exec(bucket) : null;
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]), 0).getDate();
}

function usableSeries(series: UsageComparison['current']['series']): number[] | null {
  const values = series.map((point) => point.tokens);
  return values.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0) ? values : null;
}

/**
 * 走势数据：本期实线 + 上期同进度虚线，都来自同一份 `comparison`（与胶囊同源）。
 * 任何一个桶不是有限非负数就整条不画，不拿 0 补洞。
 */
export function buildTrend(comparison: UsageComparison | null | undefined, range: WidgetRange): CardTrend | null {
  if (!comparison) return null;
  const current = usableSeries(comparison.current.series);
  const previous = usableSeries(comparison.previous.series) ?? [];
  if (!current || current.length === 0) return null;
  const bucket = comparison.window.bucket;
  const labels = comparison.current.series.map((point) => point.bucket);
  let slots: number;
  let ticks: CardTrendTick[];
  if (bucket === 'hour') {
    slots = 24;
    ticks = [0, 6, 12, 18, 24].map((hour) => ({
      at: hour / 24,
      label: String(hour).padStart(2, '0'),
      anchor: hour === 0 ? 'start' : hour === 24 ? 'end' : 'middle',
    }));
  } else if (range === 'week') {
    slots = 7;
    ticks = WEEKDAY_TICKS.map((label, index) => ({ at: (index + 0.5) / 7, label, anchor: 'middle' }));
  } else {
    slots = daysInMonthOf(labels[0]) ?? current.length;
    ticks = [1, 8, 15, 22, 29].filter((day) => day <= slots).map((day, index) => ({
      at: index === 0 ? 0 : (day - 0.5) / slots,
      label: `${day}日`,
      anchor: index === 0 ? 'start' : 'middle',
    }));
  }
  slots = Math.max(slots, current.length, previous.length);
  const previousLabel = (WIDGET_RANGES.find((item) => item.id === range) ?? WIDGET_RANGES[0]).previous;
  return {
    bucket,
    slots,
    current,
    previous,
    labels,
    ticks,
    previousLabel,
    window: { currentStart: comparison.window.currentStart, currentEnd: comparison.window.currentEnd },
  };
}

// ── 工具构成 ──────────────────────────────────────────────────────────────────

/** 工具显示名。看板、挂件、静态壁纸共用 `toolDisplayName`（TOKE-12）。 */
export { toolDisplayName };

export interface CardToolShare {
  id: string;
  name: string;
  share: number;
  percent: string;
  color: string;
}

export interface CardTools {
  items: CardToolShare[];
  other: { share: number; percent: string } | null;
}

/** 份额写整数百分比；有份额但四舍五入成 0 时写「<1%」，不写 0%。 */
export function formatShare(share: number): string {
  const percent = Math.round(share * 100);
  return percent === 0 && share > 0 ? '<1%' : `${percent}%`;
}

/** 构成条最多单列的工具数；其余并成「其他」。 */
export const TOOL_COMPOSITION_TOP = 3;

/**
 * 工具构成：按有效 Token 排名（与看板 `activeTools` 同序，同值保持原顺序）取前三，其余并成「其他」。
 * 颜色走共用槽位表（GLB-05）：`toolColorMap` 按排名顺延撞槽，只看名单前缀，所以这三名的颜色
 * 与看板同一视图里前三名相同；「其他」用中性色，不占配色 B 的槽位。
 */
export function buildTools(tools: Record<string, ToolStat> | undefined, theme: CardTheme): CardTools | null {
  if (!tools) return null;
  const ranked = Object.entries(tools)
    .map(([key, tool]) => ({ id: tool.name || key, value: effectiveTokens(tool) }))
    .filter((item) => Number.isFinite(item.value) && item.value > 0)
    .sort((left, right) => right.value - left.value);
  const total = ranked.reduce((sum, item) => sum + item.value, 0);
  if (ranked.length === 0 || !(total > 0)) return null;
  const top = ranked.slice(0, TOOL_COMPOSITION_TOP);
  const colors = toolColorMap(top.map((item) => item.id), theme);
  const rest = ranked.slice(TOOL_COMPOSITION_TOP).reduce((sum, item) => sum + item.value, 0);
  return {
    items: top.map((item) => ({
      id: item.id,
      name: toolDisplayName(item.id),
      share: item.value / total,
      percent: formatShare(item.value / total),
      color: colors.get(item.id.toLowerCase()) ?? 'var(--wl-other)',
    })),
    other: rest > 0 ? { share: rest / total, percent: formatShare(rest / total) } : null,
  };
}

// ── 额度 ──────────────────────────────────────────────────────────────────────

export interface CardQuotaItem {
  key: string;
  provider: string;
  /** 分组（账户或模型组，如「Claude Pro / Max」「Claude / GPT」）；没有分组时为空串。 */
  group: string;
  /** 窗口短名（「5 小时」「每周」「今日」）。 */
  label: string;
  /** 「分组 窗口」，与看板同名（T10.191）。 */
  window: string;
  /** 可用百分比 = 100 − round(已用)，0–100 的整数（REQ-WIDGET-02）。 */
  available: number;
  level: QuotaLevel;
  stale: boolean;
  resetsAt?: string;
  observedAt?: string;
}

export type CardQuota =
  | { kind: 'loading' }
  | { kind: 'empty' }
  /** 整次读取失败（invoke 被拒绝）：与「成功读到但没有来源」分开，不把失败画成空（P2-1，T10.192 修复轮）。 */
  | { kind: 'failed' }
  | { kind: 'pinned-missing'; name: string }
  | { kind: 'ready'; items: CardQuotaItem[] };

/** 挂件读到的额度（`quotaRead.ts`）：窗口已按吃紧程度排好。 */
export interface WidgetQuotaRead {
  highlights: QuotaWindowHighlight[];
  /** 来源 id → 显示名：钉住的来源即使一条窗口都读不到，也要能说出它叫什么。 */
  names: Map<string, string>;
  /** `来源:窗口` → 分组、窗口短名与观测时间。 */
  parts: Map<string, { group: string; label: string; observedAt?: string }>;
  /**
   * 整次读取失败（`invoke('get_local_quota_providers')` 被拒绝）时为 true；
   * 契约不合法仍按原样落到 `highlights: []`（= 没有来源），未在本修复轮改动（P2-1）。
   */
  failed?: boolean;
}

export function buildCardQuota(read: WidgetQuotaRead | null, providerId: string | null): CardQuota {
  if (!read) return { kind: 'loading' };
  if (read.failed) return { kind: 'failed' };
  const selection = selectWidgetQuota(read.highlights, providerId);
  if (selection.pinnedMissing) return { kind: 'pinned-missing', name: read.names.get(providerId ?? '') ?? providerId ?? '' };
  if (selection.highlights.length === 0) return { kind: 'empty' };
  return {
    kind: 'ready',
    items: selection.highlights.map((item) => {
      const key = `${item.providerId}:${item.windowId}`;
      const part = read.parts.get(key);
      return {
        key,
        provider: item.providerName,
        group: part?.group ?? '',
        label: part?.label ?? item.windowLabel,
        window: item.windowLabel,
        available: item.remaining,
        level: item.level,
        stale: item.status === 'stale',
        resetsAt: item.resetsAt,
        observedAt: part?.observedAt,
      };
    }),
  };
}

/** 重置时间：完整写法给读屏（「38 分钟后重置」），短写法放在环外（「38 分钟后」）。 */
export function describeReset(resetsAt: string | undefined, now: number): { long: string; short: string } | null {
  if (!resetsAt) return null;
  const at = new Date(resetsAt).getTime();
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return { long: '已到重置时间，待刷新', short: '待刷新' };
  if (minutes < 60) return { long: `${minutes} 分钟后重置`, short: `${minutes} 分钟后` };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { long: `${hours} 小时 ${minutes % 60} 分后重置`, short: `${hours} 小时 ${minutes % 60} 分后` };
  const days = Math.floor(hours / 24);
  return { long: `${days} 天 ${hours % 24} 小时后重置`, short: `${days} 天 ${hours % 24} 小时后` };
}

const OBSERVED_FORMAT = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * 圆环的文字替代：来源、窗口、可用百分比、档位与重置时间；历史快照另写「待刷新」与观测时间
 * （DESIGN §6.4 Ledger Rings 的 stale 规则）。圆环、环心数字与环外的字对读屏都是装饰，整格只读这一句。
 */
export function describeQuotaItem(item: CardQuotaItem, now: number): string {
  const parts = [`${item.provider} · ${item.window}`, `可用 ${item.available}%`, TIER_WORDS[item.level]];
  if (item.stale) {
    parts.push('待刷新');
    const observed = item.observedAt ? new Date(item.observedAt) : null;
    if (observed && Number.isFinite(observed.getTime())) parts.push(`观测于 ${OBSERVED_FORMAT.format(observed)}`);
  } else {
    const reset = describeReset(item.resetsAt, now);
    if (reset) parts.push(reset.long);
  }
  return parts.join('，');
}

/** 环外档位后面那半句：重置时间的短写法；历史快照写「待刷新」，不给已经过去的倒计时。 */
export function quotaStateTail(item: CardQuotaItem, now: number): string | null {
  if (item.stale) return '待刷新';
  return describeReset(item.resetsAt, now)?.short ?? null;
}

/**
 * 没画出来的窗口怎么看全（T10.191 评审 P3-1）：不能只放在 `title` 里，读屏与触屏拿不到。
 * 「额度总览」最多画 6 个；总数不超过 6 时换板式就能看全，超过时要去主窗口的额度看板。
 */
export function hiddenQuotaHint(total: number): string {
  return total <= QUOTA_OVERVIEW_LIMIT ? '换「额度总览」板式可看全部' : '主窗口的额度看板可看全部';
}

// ── 整张卡 ────────────────────────────────────────────────────────────────────

export interface CardStatus {
  text: string;
  /** 窄卡片显示短句；完整失败原因与上次成功读取时间供悬停和读屏获取。 */
  description?: string;
  /** 读取失败：用危险色写在「更新于」的位置，并作为 alert 播报。 */
  error: boolean;
  /** 正常的「更新于 hh:mm」之外的状态（读取中、历史快照、失败）；「单行消耗」只在这时写出来。 */
  notable: boolean;
}

export interface CardModel {
  range: WidgetRange;
  rangeLabel: string;
  /** 还没有任何一份统计：数字位写「—」，走势与构成留空。 */
  loading: boolean;
  tokens: string;
  change: MetricChange | null;
  cost: string;
  records: string;
  input: string;
  output: string;
  cache: string;
  trend: CardTrend | null;
  tools: CardTools | null;
  quota: CardQuota;
  status: CardStatus;
}

function formatClock(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}

export interface CardModelInput {
  range: WidgetRange;
  stats: StatsData | null;
  loadedAt: Date | null;
  error: string;
  quota: CardQuota;
  theme: CardTheme;
}

export function buildCardModel({ range, stats, loadedAt, error, quota, theme }: CardModelInput): CardModel {
  const rangeLabel = (WIDGET_RANGES.find((item) => item.id === range) ?? WIDGET_RANGES[0]).label;
  const summary = stats?.summary;
  // 失败只说明操作结果，不把后端异常或契约字段原样呈现给用户。
  const failure = error === '扫描失败' ? '扫描失败' : '读取失败';
  const status: CardStatus = error
    ? stats && loadedAt
      ? {
        text: `失败 · 旧快照 ${OBSERVED_FORMAT.format(loadedAt)}`,
        description: `${failure}，正在显示上次成功读取的快照。上次成功读取时间：${loadedAt.toLocaleString('zh-CN')}（本机读取时间）。请重试刷新。`,
        error: true,
        notable: true,
      }
      : { text: `${failure}，请重试`, error: true, notable: true }
    : stats && loadedAt
      ? stats.meta?.stale
        ? { text: `历史快照 · 更新于 ${formatClock(loadedAt)}`, error: false, notable: true }
        : { text: `更新于 ${formatClock(loadedAt)}`, error: false, notable: false }
      : { text: '正在读取…', error: false, notable: true };
  return {
    range,
    rangeLabel,
    loading: !stats,
    // 有效 Token = 输入 + 输出（缓存单列）；任一项读不到就整项「—」，不按 0 补。
    tokens: summary && Number.isFinite(summary.inputTokens) && Number.isFinite(summary.outputTokens)
      ? formatTokens(summaryEffectiveTokens(summary))
      : '—',
    change: stats ? describeWidgetChange(stats, range) : null,
    // 预估费用（T10.154 D49）：还在读是「—」，读到了但不可证明是「不可得」，不画 $0。
    cost: summary ? formatEstimatedUsd(summary.totalCost, 'summary') : '—',
    // 账本行数统一叫「记录数」（GLB-02）；`formatNum` 会把非数字写成 0，先挡掉。
    records: summary && Number.isFinite(summary.totalRequests) ? formatNum(summary.totalRequests) : '—',
    input: formatTokens(summary?.inputTokens),
    output: formatTokens(summary?.outputTokens),
    cache: formatTokens(summary?.cachedTokens),
    trend: stats ? buildTrend(stats.comparison, range) : null,
    tools: stats ? buildTools(stats.tools, theme) : null,
    quota,
    status,
  };
}
