import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, CalendarDays, ChevronRight, Database, FolderSearch, Info, ListTree, RefreshCw, Server, Users, type LucideIcon } from 'lucide-react';
import { EmptyState } from './EmptyState';
import { colorForTool, getPalette, toolColorMap, type BehaviorAnalysisResponse, type CustomDateRange, type DataScope, type RangeKey } from '../types';
import { formatAxisTokens, formatNum, formatTokens, formatUsdApprox } from '../utils/format';
import { getChartThemeTokens, getChartTooltip, getChartGrid, getChartAnimation, barSeriesStyle, type ChartThemeTokens } from '../utils/chartTheme';
import { useTheme } from '../utils/useTheme';
import { useSegmentedIndicator } from '../hooks/useSegmentedIndicator';
import {
  behaviorDrillRange,
  behaviorSessionDetailFilters,
  behaviorSessionKey,
  supportsBehaviorSessionAnalysis,
  useBehaviorSessionAnalysis,
  type BehaviorAnalysedWindow,
  type BehaviorSessionDrill,
  type BehaviorSessionRef,
} from '../hooks/useBehaviorAnalysisSession';
import { EChart } from './EChart';
import { heldRangeNoticeCopy } from './DashboardTab';
import { BehaviorProjectPanel, SessionProjectChip, behaviorProjectAliases, behaviorShowsSessionProject } from './behavior/BehaviorProjectPanel';
import { useHideProjectNames } from '../utils/projectNamePrivacy';
import { InfoTip } from './InfoTip';
import '../styles/workbuddyAnalytics.css';
import { useT } from '../i18n';

// The per-turn drawer is also used by the details page; load it on demand here.
const SessionAnalysisDrawer = lazy(() => import('./SessionAnalysisDrawer'));

interface Props {
  hasPageTitle?: boolean;
  data: BehaviorAnalysisResponse | null;
  /** The current query has no result yet (first load or a query change). */
  loading: boolean;
  /** The same query is reloading while `data` stays on screen (contract v1.1). */
  refreshing?: boolean;
  /** ISO time the shown result was received. */
  updatedAt?: string | null;
  error: string;
  scope: DataScope;
  range: RangeKey;
  customRange: CustomDateRange | null;
  onRangeChange: (range: RangeKey, bounds?: CustomDateRange | null) => void;
  onRetry: () => void;
  onViewLocal: () => void;
  onSelectDate?: (date: string) => void;
  /**
   * Tool ranking row: open that tool's 专属看板. `range` is null while the
   * current range still covers the analysed window, else the analysed dates to
   * open as a custom range (review F2).
   */
  onOpenTool?: (tool: string, range: CustomDateRange | null) => void;
  /** Session ranking row: open the details page with `drill.filters`, over `drill.range` when it is set. */
  onOpenSession?: (drill: BehaviorSessionDrill) => void;
  /** 行为契约 v1.2 的项目筛选；空数组表示不筛选。 */
  projectFilter?: string[];
  onProjectFilterChange?: (keys: string[]) => void;
  /** 关闭态入口：打开设置「数据与帮助」里的按项目统计卡片。 */
  onOpenProjectSettings?: () => void;
  onRebuildProjectIndex?: () => void;
  /** 本机索引回填进度；没有时用响应里的范围内计数。 */
  projectBackfill?: { done: number; total: number } | null;
  /** The local ledger has no rows at all (not just this range): the empty state offers a scan. */
  ledgerEmpty?: boolean;
  onScan?: () => void;
  scanBusy?: boolean;
}

type QuickRange = 'today' | 'threeDays' | 'sevenDays' | 'thirtyDays';

const RANGE_OPTIONS: Array<[QuickRange, string]> = [['today', '今日'], ['threeDays', '近 3 天'], ['sevenDays', '近 7 天'], ['thirtyDays', '近 30 天']];

// Presets follow the dashboard's calendar meaning (contract v1.1): this week
// from Monday, this month from the 1st, this year from January 1st. They are
// named, never described as "近 7/30/365 天".
const PRESET_NAMES: Record<Exclude<RangeKey, 'custom'>, string> = { today: '今日', week: '本周', month: '本月', year: '今年', all: '全部' };

const REFRESH_PENDING = '正在刷新…';

/** Host-local calendar day `YYYY-MM-DD`: the quick picks are host-local day counts. */
function hostDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** The page's name for the current selection; dates come from `meta.start/end`. */
function behaviorRangeName(range: RangeKey, preset: string): string {
  if (range !== 'custom') return PRESET_NAMES[range];
  return RANGE_OPTIONS.find(([id]) => id === preset)?.[1] ?? '自定义区间';
}

function sameCustomRange(left: CustomDateRange | null, right: CustomDateRange | null): boolean {
  return left?.start === right?.start && left?.end === right?.end;
}

/**
 * A frame's range name for the "keep the old range on screen while a new one
 * loads" notice (T10.201, T10.181 review open point 7). Unlike
 * `behaviorRangeName`, this does not need the quick-pick `preset` state (only
 * tracked for the live selection), so it can also name an older held frame.
 */
function behaviorRangeSwitchLabel(range: RangeKey, customRange: CustomDateRange | null): string {
  if (range !== 'custom') return PRESET_NAMES[range];
  return customRange ? `${customRange.start} 至 ${customRange.end}` : '自定义区间';
}

/** A held frame: the last result shown, and the query it answers (T10.201). */
interface BehaviorFrame {
  data: BehaviorAnalysisResponse;
  range: RangeKey;
  customRange: CustomDateRange | null;
}

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/;

function parseWallClock(value: string | null | undefined) {
  const match = WALL_CLOCK.exec(value ?? '');
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), date: `${match[1]}-${match[2]}-${match[3]}`, time: `${match[4]}:${match[5]}` };
}

/**
 * Compact start–end of a session inside the analysed range. `firstAt/lastAt`
 * are wall-clock times in the query's (local) timezone, so they are read as
 * text, never re-parsed through the host clock. The year is shown only when
 * the span crosses a year or is not in `referenceYear`.
 */
export function formatBehaviorSessionSpan(firstAt: string | null | undefined, lastAt: string | null | undefined, referenceYear?: number): string | null {
  const first = parseWallClock(firstAt);
  const last = parseWallClock(lastAt) ?? first;
  if (!first || !last) return null;
  const withYear = first.year !== last.year || (referenceYear !== undefined && first.year !== referenceYear);
  const day = (part: NonNullable<typeof first>) => (withYear ? `${part.year}/${part.month}/${part.day}` : `${part.month}/${part.day}`);
  if (first.date === last.date) return first.time === last.time ? `${day(first)} ${first.time}` : `${day(first)} ${first.time}–${last.time}`;
  return `${day(first)} ${first.time} – ${day(last)} ${last.time}`;
}

/**
 * 会话预估费用: a price-table estimate, never a bill. Unknown (null, missing
 * or not a finite non-negative number) is 「不可得」 and never `$0`; a real
 * zero stays ≈$0.00 (GLB-01, T10.154 §4.1).
 */
export function formatBehaviorSessionCost(cost: number | null | undefined): string {
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return '不可得';
  if (cost === 0) return '≈$0.00';
  if (cost < 0.01) return '<$0.01';
  return formatUsdApprox(cost);
}

/** When the shown result was received: `HH:mm` today, `M/D HH:mm` on an earlier day. */
function formatReceivedAt(value: string | null | undefined, now = new Date()): string | null {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  const time = at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return sameDay ? time : `${at.getMonth() + 1}/${at.getDate()} ${time}`;
}

/**
 * A tool's session count (contract v1.1 `tools[].unknownSessionRecords`).
 * A source whose records all lack a session ID (MiniMax, Tencent Marvis) has
 * an unknown number of sessions: 「会话未知」, never "0 会话" (GLB-01). A partial
 * count names the records it leaves out. Without the field (an older backend),
 * `sessionCount` 0 with records still can only mean an unknown count.
 */
export function formatBehaviorToolSessions(tool: { requests: number; sessionCount: number; unknownSessionRecords?: number | null }): string {
  const unknown = typeof tool.unknownSessionRecords === 'number' && tool.unknownSessionRecords > 0 ? tool.unknownSessionRecords : 0;
  if (tool.sessionCount === 0 && (unknown > 0 || tool.requests > 0)) return '会话未知';
  if (unknown > 0) return `${formatNum(tool.sessionCount)} 会话 · 另 ${formatNum(unknown)} 条缺少会话 ID`;
  return `${formatNum(tool.sessionCount)} 会话`;
}

/** A session's top model; an explicit null (or empty name) is 「不可得」, an absent field (older backend) says nothing. */
export function formatBehaviorTopModel(topModel: string | null | undefined): string | null {
  if (topModel === undefined) return null;
  return topModel && topModel.trim() ? topModel : '主模型不可得';
}

type LegendChart = 'modelDay' | 'modelHour';

/** The remembered legend choice of a chart for this window; a copy, so a later choice never mutates a built option. */
function legendChoicesFor(choices: { key: string } & Record<LegendChart, Record<string, boolean>>, windowKey: string, chart: LegendChart): Record<string, boolean> {
  return choices.key === windowKey ? { ...choices[chart] } : {};
}

/** A ranking row's main target: a real button when it leads somewhere, plain text otherwise. */
function RankRowMain({ onActivate, title, action, children }: { onActivate?: () => void; title?: string; action: string; children: ReactNode }) {
  if (!onActivate) return <div className="behavior-rank-main" title={title}>{children}</div>;
  return <button type="button" className="behavior-rank-main" title={title} onClick={onActivate}>
    {children}
    <ChevronRight className="behavior-rank-go" size={16} aria-hidden="true" />
    <span className="sr-only">，{action}</span>
  </button>;
}

function sumBy<T>(rows: T[], key: (row: T) => string, value: (row: T) => number) {
  const result = new Map<string, number>();
  rows.forEach(row => result.set(key(row), (result.get(key(row)) || 0) + value(row)));
  return result;
}

function calendarDates(start: string, end: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${start}T12:00:00Z`);
  const last = new Date(`${end}T12:00:00Z`);
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function shortDate(date: string): string {
  const [, month, day] = date.split('-');
  return `${Number(month)}/${Number(day)}`;
}

function categoryAxis(data: string[], theme: ChartThemeTokens, formatter?: (value: string) => string) {
  return {
    type: 'category', data,
    axisLabel: { color: theme.textSecondary, hideOverlap: true, formatter },
    axisLine: { lineStyle: { color: theme.borderStrong } },
    axisTick: { show: false },
  };
}

function valueAxis(theme: ChartThemeTokens, formatter: (value: number) => string, minInterval?: number) {
  return {
    type: 'value', minInterval,
    axisLabel: { color: theme.textSecondary, formatter },
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: theme.borderFaint } },
  };
}

export function BehaviorAnalysisView({ hasPageTitle = false, data: dataProp, loading, refreshing = false, updatedAt = null, error, scope, range, customRange, onRangeChange, onRetry, onViewLocal, onSelectDate, onOpenTool, onOpenSession, projectFilter = [], onProjectFilterChange, onOpenProjectSettings, onRebuildProjectIndex, projectBackfill = null, ledgerEmpty = false, onScan, scanBusy = false }: Props) {
  const t = useT();
  const { effective } = useTheme(); // Tool-ranking/session-ranking colours below must recompute on theme toggle (T10.178 review P2-1).
  const { hidden: hideProjectNames, setHidden: setHideProjectNames } = useHideProjectNames();
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [dayOffset, setDayOffset] = useState(0);
  const [draftStart, setDraftStart] = useState(customRange?.start || '');
  const [draftEnd, setDraftEnd] = useState(customRange?.end || '');
  const [preset, setPreset] = useState<string>(range);
  const [customExpanded, setCustomExpanded] = useState(false);
  const rangeErrorId = useId();
  const showCustomRange = customExpanded || preset === 'custom';
  const invalidDraftRange = Boolean(draftStart && draftEnd && draftEnd < draftStart);
  const palette = getPalette();
  const chartTheme = getChartThemeTokens();
  const rangeSegRef = useSegmentedIndicator<HTMLDivElement>();
  const toolRankTitleId = useId();
  const sessionRankTitleId = useId();
  // T10.201（T10.181 评审待定点 7）：换范围时旧结果被清空、新结果还没到，这一拍原来落进下面的
  // 加载骨架，图表实例全部随之卸载重建。现在留住上一帧：页内说明正在加载哪一段、下方仍是哪一段
  // 的数据，图表实例不跟着卸载（与总览 DashboardTab 的保留旧画面规则一致，R-46）。只在纯粹换了
  // 范围、没有真正错误时留旧帧；作用域切换本来就是另一个入口（见下方 scope === 'cloud' 提前返回），
  // 真正的加载失败仍按原规则清空并显示错误。
  const currentFrame = useMemo<BehaviorFrame | null>(
    () => (dataProp ? { data: dataProp, range, customRange } : null),
    [dataProp, range, customRange],
  );
  const [shownFrame, setShownFrame] = useState<BehaviorFrame | null>(null);
  const rangeSwitchPending = !currentFrame
    && !error
    && shownFrame !== null
    && (shownFrame.range !== range || !sameCustomRange(shownFrame.customRange, customRange));
  const frame = currentFrame ?? (rangeSwitchPending ? shownFrame : null);
  if (frame !== shownFrame) setShownFrame(frame);
  const data = frame?.data ?? null;
  const heldRangeNotice = rangeSwitchPending && shownFrame
    ? heldRangeNoticeCopy(behaviorRangeSwitchLabel(range, customRange), behaviorRangeSwitchLabel(shownFrame.range, shownFrame.customRange))
    : '';
  // The dates this result was analysed over. Presets were resolved when it was
  // requested, so lookups and drill-downs use these, not the current preset,
  // which may already mean another day (review F2).
  const analysedWindow: BehaviorAnalysedWindow | null = data
    ? { range: data.meta.range, start: data.meta.start, end: data.meta.end, timezone: data.meta.timezone }
    : null;
  const sessionAnalysis = useBehaviorSessionAnalysis(analysedWindow);
  useEffect(() => {
    setDraftStart(customRange?.start || '');
    setDraftEnd(customRange?.end || '');
  }, [range, customRange]);
  // A 近 N 天 pick includes today, so it is judged again on a new local day:
  // after midnight the same dates are a plain custom range (review F10). The
  // check runs on the next render of that day.
  const hostToday = hostDay(new Date());
  useEffect(() => {
    if (range !== 'custom') setPreset(range);
    else if (customRange) {
      const [year, month, day] = hostToday.split('-').map(Number);
      const quick = ([3, 7, 30] as const).find(days => (
        customRange.start === hostDay(new Date(year, month - 1, day - days + 1)) && customRange.end === hostToday
      ));
      setPreset(quick === 3 ? 'threeDays' : quick === 7 ? 'sevenDays' : quick === 30 ? 'thirtyDays' : 'custom');
    }
  }, [range, customRange, hostToday]);
  // Reset the drill-down selection when the analysed window changes, not on
  // every result: a refresh of the same query keeps the chosen date, hour,
  // model and page (T10.151 hand-off item 5).
  const windowKey = data ? `${data.meta.range}|${data.meta.start}|${data.meta.end}|${data.meta.timezone}` : '';
  // Series hidden from the two model legends survive a refresh of the same
  // window (T10.150 QA F9): a changed result rebuilds the chart option with
  // notMerge, which would show every series again. The choice is kept outside
  // React state, so a legend click itself re-renders nothing and the chart
  // keeps its own toggle; a new window starts with every series shown.
  const legendChoices = useRef<{ key: string } & Record<LegendChart, Record<string, boolean>>>({ key: '', modelDay: {}, modelHour: {} });
  const rememberLegend = (chart: LegendChart, selected: unknown) => {
    if (!selected || typeof selected !== 'object') return;
    const current = legendChoices.current.key === windowKey ? legendChoices.current : { key: windowKey, modelDay: {}, modelHour: {} };
    legendChoices.current = { ...current, [chart]: { ...(selected as Record<string, boolean>) } };
  };
  useEffect(() => { setSelectedDate(null); setSelectedHour(null); setSelectedModel(''); setDayOffset(0); }, [windowKey]);
  const dates = useMemo(() => data ? calendarDates(data.meta.start, data.meta.end) : [], [data]);
  const visibleDates = useMemo(() => dates.slice(Math.max(0, dates.length - 14 - dayOffset), dates.length - dayOffset), [dates, dayOffset]);
  const daily = useMemo(() => {
    const result = new Map<string, number>();
    if (selectedHour === null) {
      for (const row of data?.modelDays || []) result.set(row.date, (result.get(row.date) || 0) + row.tokens);
    } else {
      for (const row of data?.dayHours || []) {
        if (row.hour === selectedHour) result.set(row.date, (result.get(row.date) || 0) + row.tokens);
      }
    }
    return result;
  }, [data, selectedHour]);
  const hours = useMemo(() => sumBy(data?.modelHours || [], row => String(row.hour), row => row.tokens), [data]);
  const dayOption = useMemo(() => ({
    color: [palette[0]],
    ...getChartAnimation(chartTheme.reduceMotion),
    tooltip: getChartTooltip(chartTheme, { trigger: 'axis', valueFormatter: (value: number) => `${formatTokens(value)} Tokens` }),
    grid: getChartGrid({ top: 20, bottom: 32 }),
    xAxis: categoryAxis(visibleDates, chartTheme, shortDate),
    yAxis: valueAxis(chartTheme, formatAxisTokens, 1),
    // barMaxWidth caps a single bucket (e.g. a one-day range) from stretching
    // into one giant slab (5.5 图表规格 / T10.150 motion+bar audit).
    series: [{ type: 'bar', barMaxWidth: 36, itemStyle: barSeriesStyle(palette[0], 'vertical').itemStyle, data: visibleDates.map(date => ({ value: daily.get(date) || 0, date })) }],
  }), [chartTheme, daily, visibleDates, palette]);
  const hourOption = useMemo(() => ({
    color: [palette[1]],
    ...getChartAnimation(chartTheme.reduceMotion),
    tooltip: getChartTooltip(chartTheme, { trigger: 'axis', valueFormatter: (value: number) => `${formatTokens(value)} Tokens` }),
    grid: getChartGrid({ top: 20, bottom: 32 }), xAxis: categoryAxis(Array.from({ length: 24 }, (_, i) => `${i}`), chartTheme),
    yAxis: valueAxis(chartTheme, formatAxisTokens, 1),
    series: [{ type: 'bar', barMaxWidth: 22, itemStyle: barSeriesStyle(palette[1], 'vertical').itemStyle, data: Array.from({ length: 24 }, (_, i) => hours.get(String(i)) || 0) }],
  }), [chartTheme, hours, palette]);
  const heatValues = useMemo(() => new Map((data?.dayHours || []).map(row => [`${row.date}|${row.hour}`, row.tokens])), [data]);
  const heatPeak = useMemo(() => Math.max(1, ...(data?.dayHours || []).map(row => row.tokens)), [data]);
  // data.tools arrives ranked by effective tokens desc ("按有效 Token 排序");
  // resolve same-slot collisions once by that rank, and share the one
  // resulting map with the session-ranking list below so the same tool reads
  // the same colour in both lists on this page (T10.178 review P1-1). `effective`
  // must be in the dependency array or a theme toggle leaves stale colours on
  // screen until some unrelated re-render happens to recompute them (P2-1).
  const toolColorAssignment = useMemo(
    () => toolColorMap((data?.tools || []).map((item) => item.id), effective),
    [data, effective],
  );
  const modelDayOption = useMemo(() => {
    const totals = sumBy(data?.modelDays || [], row => row.model, row => row.tokens);
    const topModels = [...totals.keys()].sort((a, b) => (totals.get(b) || 0) - (totals.get(a) || 0)).slice(0, 6);
    const topSet = new Set(topModels);
    const byDateModel = sumBy(data?.modelDays || [], row => `${row.date}|${topSet.has(row.model) ? row.model : '其他模型'}`, row => row.tokens);
    const models = totals.size > topModels.length ? [...topModels, '其他模型'] : topModels;
    return {
      color: palette,
      ...getChartAnimation(chartTheme.reduceMotion),
      tooltip: getChartTooltip(chartTheme, { trigger: 'axis' }), legend: { top: 0, textStyle: { color: chartTheme.textSecondary }, selectedMode: true, selected: legendChoicesFor(legendChoices.current, windowKey, 'modelDay') },
      grid: getChartGrid({ top: 70, bottom: 32 }),
      xAxis: categoryAxis(visibleDates, chartTheme, shortDate),
      yAxis: valueAxis(chartTheme, formatAxisTokens, 1),
      series: models.map((model, index) => ({
        name: model,
        type: 'bar',
        stack: 'tokens',
        barMaxWidth: 36,
        itemStyle: { color: barSeriesStyle(palette[index % palette.length], 'vertical').itemStyle.color },
        data: visibleDates.map(date => byDateModel.get(`${date}|${model}`) || 0),
      })),
    };
  }, [chartTheme, data, visibleDates, palette, windowKey]);
  const modelHourOption = useMemo(() => {
    const totals = sumBy(data?.modelHours || [], row => row.model, row => row.tokens);
    const topModels = [...totals.keys()].sort((a, b) => (totals.get(b) || 0) - (totals.get(a) || 0)).slice(0, 6);
    const topSet = new Set(topModels);
    const byHourModel = sumBy(data?.modelHours || [], row => `${row.hour}|${topSet.has(row.model) ? row.model : '其他模型'}`, row => row.tokens);
    const models = totals.size > topModels.length ? [...topModels, '其他模型'] : topModels;
    return {
      color: palette,
      ...getChartAnimation(chartTheme.reduceMotion),
      tooltip: getChartTooltip(chartTheme, { trigger: 'axis' }), legend: { top: 0, textStyle: { color: chartTheme.textSecondary }, selectedMode: true, selected: legendChoicesFor(legendChoices.current, windowKey, 'modelHour') },
      grid: getChartGrid({ top: 54, bottom: 32 }), xAxis: categoryAxis(Array.from({ length: 24 }, (_, i) => `${i}`), chartTheme), yAxis: valueAxis(chartTheme, formatAxisTokens, 1),
      series: models.map((model, index) => ({
        name: model,
        type: 'bar',
        stack: 'tokens',
        barMaxWidth: 24,
        itemStyle: { color: barSeriesStyle(palette[index % palette.length], 'vertical').itemStyle.color },
        data: Array.from({ length: 24 }, (_, hour) => byHourModel.get(`${hour}|${model}`) || 0),
      })),
    };
  }, [chartTheme, data, palette, windowKey]);
  const currentRequestModel = data?.requestSizes.find(item => item.model === selectedModel) || data?.requestSizes[0];
  const selectedDateValue = selectedDate && dates.includes(selectedDate) ? selectedDate : '';
  const requestSizeOption = useMemo(() => ({
    color: [palette[0]],
    ...getChartAnimation(chartTheme.reduceMotion),
    tooltip: getChartTooltip(chartTheme, { trigger: 'axis' }),
    grid: getChartGrid({ top: 18, bottom: 38 }),
    xAxis: categoryAxis(currentRequestModel?.bins.map(bin => `${formatTokens(bin.lower)}–${formatTokens(bin.upper)}`) || [], chartTheme),
    yAxis: valueAxis(chartTheme, formatNum, 1),
    series: [{ type: 'bar', barMaxWidth: 36, itemStyle: barSeriesStyle(palette[0], 'vertical').itemStyle, data: currentRequestModel?.bins.map(bin => bin.requests) || [] }],
  }), [chartTheme, currentRequestModel, palette]);
  const rangeName = behaviorRangeName(range, preset);
  // `all` is capped to the latest `rangeDayLimit` local days (contract v1.1);
  // say so only when older local records were actually left out.
  const rangeTruncated = data?.meta.range === 'all' && data.meta.rangeTruncated === true;
  const rangeDayLimit = data?.meta.rangeDayLimit ?? 731;
  const coverage = data?.meta
    ? [
      rangeTruncated ? `${rangeName} · 最近 ${formatNum(rangeDayLimit)} 天` : rangeName,
      data.meta.start === data.meta.end ? data.meta.start : `${data.meta.start} 至 ${data.meta.end}`,
      `${data.meta.recordCount.toLocaleString()} 条本机账本记录`,
    ].join(' · ')
    : `${rangeName} · 本机当前账本覆盖`;
  // Records whose source carries no session ID are real usage but not a
  // session (contract v1.1). A missing field means an older backend: no note.
  const unknownSessionRecords = data?.summary.unknownSessionRecords ?? 0;
  const unknownSessionTokens = data?.summary.unknownSessionTokens;
  // With every record lacking a session ID the session count is unknown, not 0.
  // The same rule as a tool row: an older backend without the unknown count
  // still reports records but no session.
  const sessionsUnknown = Boolean(data && data.summary.sessionCount === 0 && (unknownSessionRecords > 0 || data.summary.requests > 0));
  const sessionCountLabel = sessionsUnknown ? '不可得' : formatNum(data?.summary.sessionCount ?? 0);
  const sessionCountNote = unknownSessionRecords > 0
    ? `${sessionsUnknown ? '' : '另有 '}${formatNum(unknownSessionRecords)} 条记录缺少会话 ID`
    : sessionsUnknown ? '记录缺少会话 ID' : null;
  const busy = loading || refreshing || rangeSwitchPending;
  const receivedAt = formatReceivedAt(updatedAt);
  // Only a refresh the user asked for is announced (review F4). Background
  // refreshes after a scan or sync change the visible status text quietly, and
  // a first failure is announced by the alert banner instead.
  const [refreshAnnouncement, setRefreshAnnouncement] = useState('');
  const wasBusy = useRef(busy);
  // The hook keeps `error` until a retry settles (T10.164 review N1): whether
  // the banner stayed up from the start of this refresh decides what its end says.
  const failedBefore = useRef(false);
  // 「仍显示」 needs a result on screen, the banner's own condition: the hook's
  // reset (a switch to cloud and back) drops the result and swaps the error
  // text in one step, without the empty error the guard below relies on.
  const hasResult = data !== null;
  useEffect(() => {
    const started = !wasBusy.current && busy;
    const finished = wasBusy.current && !busy;
    wasBusy.current = busy;
    // A new query clears `error` (and the shown result) mid-refresh; its own
    // failure is a first one again and is told by the new banner.
    if (!error) failedBefore.current = false;
    if (started) {
      failedBefore.current = Boolean(error);
      setRefreshAnnouncement(current => (current === REFRESH_PENDING ? current : ''));
    } else if (finished && error) {
      // Cleared only when this refresh ends in failure. A first failure is told
      // by the new banner; a manual retry that fails again leaves the banner
      // unchanged, so role="alert" says nothing and this region has to.
      setRefreshAnnouncement(current => (current === REFRESH_PENDING && failedBefore.current && hasResult ? `刷新失败，仍显示${receivedAt ? ` ${receivedAt} ` : '上一次'}的结果` : ''));
    } else if (finished) setRefreshAnnouncement(current => (current === REFRESH_PENDING ? `已刷新，更新于 ${receivedAt ?? '刚才'}` : current));
  }, [busy, error, receivedAt, hasResult]);
  const referenceYear = data ? Number(data.meta.end.slice(0, 4)) : undefined;
  const sessionActions = Boolean(data?.sessions.some(session => supportsBehaviorSessionAnalysis(session.tool)));
  const showSessionProject = behaviorShowsSessionProject(data);
  const projectAliases = useMemo(
    () => behaviorProjectAliases(data, hideProjectNames),
    [data, hideProjectNames],
  );
  // Drill-downs decide at press time whether the current range still covers
  // the analysed window (for example after midnight it no longer does).
  const openTool = onOpenTool && analysedWindow
    ? (tool: string) => onOpenTool(tool, behaviorDrillRange(analysedWindow))
    : undefined;
  const openSession = onOpenSession && analysedWindow
    ? (session: BehaviorSessionRef) => onOpenSession({ session, filters: behaviorSessionDetailFilters(session), range: behaviorDrillRange(analysedWindow) })
    : undefined;
  if (scope === 'cloud') return <section className="content-stack behavior-analysis-view"><div className="panel empty-panel"><Database className="h-5 w-5" /><div>{hasPageTitle ? <h2>行为分析仅支持本机</h2> : <h1>行为分析仅支持本机</h1>}<p>云端看板不提供完整行为聚合，也不会从有限历史样本推断全量行为。项目维度仅在本机视图可用。</p><button className="primary-inline" type="button" onClick={onViewLocal}>切换到本机查看</button></div></div></section>;
  const choosePreset = (id: QuickRange) => {
    setCustomExpanded(false);
    setPreset(id);
    if (id === 'today') return onRangeChange('today');
    const days = id === 'threeDays' ? 3 : id === 'sevenDays' ? 7 : 30;
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - days + 1);
    onRangeChange('custom', { start: hostDay(start), end: hostDay(end) });
  };
  return <section className="content-stack behavior-analysis-view" aria-busy={busy || undefined}>
    {/* 范围栏是第一行，与概览/记录的页内工具行同一位置；页名由侧栏与子标签给出，这里不再写可见大标题（T10.276）。 */}
    <div className="behavior-range-bar">
      <div className="segmented tl-seg behavior-range-segmented" role="group" aria-label="行为分析时间范围" ref={rangeSegRef}>
        {RANGE_OPTIONS.map(([id, label]) => <button key={id} type="button" className={!showCustomRange && preset === id ? 'active' : ''} aria-pressed={!showCustomRange && preset === id} onClick={() => choosePreset(id)}>{label}</button>)}
        <button type="button" className={showCustomRange ? 'active' : ''} aria-pressed={showCustomRange} onClick={() => setCustomExpanded(true)}>自定义</button>
      </div>
      {showCustomRange && <form className="behavior-custom-range" aria-label="自定义行为分析区间" onSubmit={event => { event.preventDefault(); if (draftStart && draftEnd && !invalidDraftRange) onRangeChange('custom', { start: draftStart, end: draftEnd }); }}>
        <CalendarDays className="h-4 w-4" aria-hidden="true" />
        <input aria-label="自定义起始日期" type="date" required aria-invalid={invalidDraftRange || undefined} aria-describedby={invalidDraftRange ? rangeErrorId : undefined} value={draftStart} onChange={event => setDraftStart(event.target.value)} />
        <span>至</span>
        <input aria-label="自定义结束日期" type="date" required aria-invalid={invalidDraftRange || undefined} aria-describedby={invalidDraftRange ? rangeErrorId : undefined} value={draftEnd} onChange={event => setDraftEnd(event.target.value)} />
        <button type="submit" className="behavior-apply-range" disabled={!draftStart || !draftEnd || invalidDraftRange}>分析区间</button>
      </form>}
    </div>
    <div className="page-heading behavior-analysis-heading">
      {/* U-102：范围与记录数已在范围栏和指标卡里，口径行收进 ⓘ。 */}
      <div className="behavior-heading-info">{!hasPageTitle && <h1 className="sr-only">行为分析</h1>}{data && <span className="behavior-applied-range">已应用 {data.meta.start} 至 {data.meta.end}</span>}<InfoTip label="统计范围与口径"><span>{coverage}</span><span>有效 Token = 输入 + 输出</span></InfoTip>{heldRangeNotice && <p className="page-subtitle" role="status">{heldRangeNotice}</p>}</div>
      <div className="behavior-refresh">
        {/* Text, not only the spinner, carries the state: reduced motion stops the spin. */}
        {/* 刷新中的文字要看得见（reduced motion 下不转圈）；完成后的「更新于」与顶栏重复，只留给读屏（U-102）。 */}
        <span className="behavior-refresh-status">{refreshing ? REFRESH_PENDING : !loading && receivedAt ? <time className="sr-only" dateTime={updatedAt ?? undefined}>更新于 {receivedAt}</time> : null}</span>
        <span className="sr-only" role="status">{refreshAnnouncement}</span>
        {/* aria-disabled keeps keyboard focus on the button while it works; a
            repeated press is ignored and the shown result stays on screen. */}
        <button className="ghost-inline behavior-refresh-button" type="button" aria-disabled={busy || undefined} onClick={() => { if (!busy) { setRefreshAnnouncement(REFRESH_PENDING); onRetry(); } }}><RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />刷新</button>
      </div>
    </div>
    {showCustomRange && invalidDraftRange && <p id={rangeErrorId} className="behavior-range-error" role="alert">结束日期不能早于开始日期。</p>}
    {rangeTruncated && data && <p className="behavior-range-note"><Info className="h-4 w-4" aria-hidden="true" /><span>「全部」在行为分析中只统计最近 {formatNum(rangeDayLimit)} 天（{data.meta.start} 起）；更早的本机记录未计入本页，从排行打开的专属看板与明细仍按完整「全部」统计。</span></p>}
    {/* A failed refresh keeps the previous result on screen; say it is not the latest. */}
    {/* One text column (review F5): the banner spreads its direct children apart. */}
    {error && <div className="cloud-recovery-banner" role="alert"><div><strong>读取失败</strong><span>{error}</span>{data && <span>下方仍是{receivedAt ? ` ${receivedAt} ` : '上一次'}取得的结果，不是最新。</span>}</div></div>}
    {loading && !data ? <div className="panel behavior-loading" role="status">正在聚合本机账本…</div> : data && <>
      <div className="behavior-summary-grid">{([
        ['有效 Token', formatTokens(data.summary.tokens), Activity, null],
        ['账本记录数', formatNum(data.summary.requests), Server, null],
        ['活跃天数', formatNum(data.summary.activeDays), CalendarDays, null],
        ['会话数', sessionCountLabel, Users, sessionCountNote],
      ] as Array<[string, string, LucideIcon, string | null]>).map(([label, value, Icon, note]) => <div className="panel behavior-stat" key={label}><span className="behavior-stat-icon" aria-hidden="true"><Icon className="h-4 w-4" /></span><span className="behavior-stat-text"><span className="behavior-stat-label">{label}</span><strong>{value}</strong>{note && <small className="behavior-stat-note">{note}</small>}</span></div>)}</div>
      <BehaviorProjectPanel
        data={data}
        projectFilter={projectFilter}
        onProjectFilterChange={onProjectFilterChange}
        onOpenSettings={onOpenProjectSettings}
        onRebuild={onRebuildProjectIndex}
        backfill={projectBackfill}
        hideNames={hideProjectNames}
        onHideNamesChange={setHideProjectNames}
      />
      {data.summary.requests === 0 ? (!ledgerEmpty ? (
        <EmptyState icon={CalendarDays} title={t('empty.sessions.rangeTitle')} description={t('empty.sessions.rangeDescription')}>
          {range !== 'custom' || preset !== 'thirtyDays' ? <button type="button" className="secondary-inline" onClick={() => choosePreset('thirtyDays')}>{t('empty.sessions.rangeAction')}</button> : null}
        </EmptyState>
      ) : (
        <EmptyState icon={FolderSearch} title={t('empty.sessions.title')} description={t('empty.sessions.description')}>
          {onScan && <button type="button" className="primary-inline" onClick={onScan} disabled={scanBusy} aria-busy={scanBusy || undefined}><RefreshCw className={`h-4 w-4 ${scanBusy ? 'animate-spin' : ''}`} />{t('empty.sessions.action')}</button>}
        </EmptyState>
      )) : <>
        <div className="behavior-day-pager" aria-label="分析日期窗口">
          <span>当前显示 {visibleDates[0]} 至 {visibleDates[visibleDates.length - 1]} · 全区间 {dates.length} 天</span>
          <button type="button" disabled={dayOffset + 14 >= dates.length} onClick={() => setDayOffset(offset => Math.min(dates.length - 14, offset + 14))}>较早日期</button>
          <button type="button" disabled={dayOffset === 0} onClick={() => setDayOffset(offset => Math.max(0, offset - 14))}>较近日期</button>
        </div>
        <div className="behavior-chart-grid">
          <div className="panel behavior-chart-card">
            <div className="workbuddy-card-header"><h2>{selectedHour === null ? '每日活动' : `每日活动 · ${selectedHour}:00`}<InfoTip label="每日活动说明">有效 Token · 点击柱形选择日期</InfoTip></h2></div>
            <div className="behavior-chart"><EChart option={dayOption} ariaLabel="每日行为活动" onEvents={{ click: (params: { name?: string }) => { if (params.name) setSelectedDate(params.name); } }} /></div>
          </div>
          <div className="panel behavior-chart-card">
            <div className="workbuddy-card-header"><h2>小时节奏<InfoTip label="小时节奏说明">跨日合计 · 点击时柱联动每日图</InfoTip></h2>{selectedHour !== null && <span>{selectedHour}:00 已选择</span>}</div>
            <div className="behavior-chart"><EChart option={hourOption} ariaLabel="小时行为活动" onEvents={{ click: (params: { dataIndex?: number }) => setSelectedHour(typeof params.dataIndex === 'number' ? params.dataIndex : null) }} /></div>
          </div>
        </div>
        <div className="behavior-selection-bar">
          <label>查看日期 <select aria-label="选择下钻日期" value={selectedDateValue} onChange={event => setSelectedDate(event.target.value || null)}><option value="">请选择</option>{dates.map(date => <option key={date} value={date}>{date}</option>)}</select></label>
          <button type="button" disabled={!selectedDateValue} onClick={() => selectedDateValue && onSelectDate?.(selectedDateValue)}>查看当日明细</button>
          {selectedHour !== null && <button type="button" onClick={() => setSelectedHour(null)}>清除小时筛选</button>}
        </div>
        <div className="behavior-chart-grid">
          <div className="panel behavior-chart-card">
            <div className="workbuddy-card-header"><h2>日期 × 小时热力<InfoTip label="热力说明">选择格子联动 · 窗口较窄时可横向滚动</InfoTip></h2></div>
            <div className="behavior-heatmap-scroll" role="region" aria-label="日期小时矩阵，可横向滚动" tabIndex={0}>
              <div className="behavior-heatmap-grid">
                <div className="behavior-heatmap-corner" aria-hidden="true" />
                {Array.from({ length: 24 }, (_, hour) => <span className="behavior-heatmap-hour" key={hour}>{hour % 3 === 0 ? hour : ''}</span>)}
                {visibleDates.map(date => <div className="behavior-heatmap-row" key={date}>
                  <span className="behavior-heatmap-date">{date.slice(5)}</span>
                  {Array.from({ length: 24 }, (_, hour) => {
                    const tokens = heatValues.get(`${date}|${hour}`) || 0;
                    const level = tokens === 0 ? 0 : Math.max(1, Math.ceil(tokens / heatPeak * 5));
                    const selected = selectedDate === date && selectedHour === hour;
                    return <button key={hour} type="button" className="behavior-heatmap-cell" data-level={level} aria-pressed={selected} aria-label={`${date} ${hour}:00，有效 Token ${formatTokens(tokens)}`} title={`${date} ${hour}:00 · ${formatTokens(tokens)}`} onClick={() => { setSelectedDate(date); setSelectedHour(hour); }} />;
                  })}
                </div>)}
              </div>
            </div>
          </div>
          <div className="panel behavior-chart-card"><div className="workbuddy-card-header"><h2>每日模型用量<InfoTip label="每日模型用量说明">前 6 模型 + 其他 · 点击日期选择</InfoTip></h2></div><div className="behavior-chart"><EChart option={modelDayOption} ariaLabel="每日模型用量" onEvents={{ click: (params: { name?: string }) => { if (params.name) setSelectedDate(params.name); }, legendselectchanged: (params: { selected?: unknown }) => rememberLegend('modelDay', params.selected) }} /></div></div>
        </div>
        <div className="panel behavior-chart-card"><div className="workbuddy-card-header"><h2>模型时段分布<InfoTip label="模型时段分布说明">前 6 模型 + 其他 · 跨日合计</InfoTip></h2></div><div className="behavior-chart"><EChart option={modelHourOption} ariaLabel="模型时段分布" onEvents={{ click: (params: { dataIndex?: number }) => setSelectedHour(typeof params.dataIndex === 'number' ? params.dataIndex : null), legendselectchanged: (params: { selected?: unknown }) => rememberLegend('modelHour', params.selected) }} /></div></div>
        <div className="behavior-detail-grid">
          <div className="panel behavior-rank-panel">
            <div className="behavior-rank-head">
              <h2 id={toolRankTitleId}>工具排行 <small>（{data.tools.length} 种）</small></h2>
              <InfoTip label="工具排行说明">按有效 Token 排序{openTool ? ' · 点击工具打开专属看板' : ''}</InfoTip>
            </div>
            <ol className="behavior-rank-list tl-scrollbar" role="list" aria-labelledby={toolRankTitleId}>{data.tools.map((item) => <li className="behavior-rank-row" key={item.id}>
              <RankRowMain onActivate={openTool ? () => openTool(item.id) : undefined} title={openTool ? `打开 ${item.id} 专属看板` : undefined} action="打开专属看板">
                <span className="behavior-rank-name"><span className="entity-dot" style={{ color: toolColorAssignment.get(item.id.toLowerCase()) ?? colorForTool(item.id, 0, effective) }} aria-hidden="true" /><span>{item.id}</span></span>
                <strong className="behavior-rank-value">{formatTokens(item.tokens)}<span className="sr-only"> 有效 Token</span></strong>
                <span className="behavior-rank-meta">{formatNum(item.requests)} 条记录 · {formatBehaviorToolSessions(item)}</span>
              </RankRowMain>
            </li>)}</ol>
          </div>
          <div className="panel behavior-rank-panel">
            <div className="behavior-rank-head">
              <h2 id={sessionRankTitleId}>会话排行 <small>（{data.meta.sessionsTruncated ? `前 ${formatNum(data.meta.sessionLimit)} 条` : `${data.sessions.length} 条`}）</small></h2>
              <InfoTip label="会话排行说明">按有效 Token 排序 · 起止为区间内首末记录 · 会话预估费用按价格表估算，非账单{openSession ? ' · 点击会话查看明细' : ''}</InfoTip>
              {unknownSessionRecords > 0 && <p className="behavior-rank-note">另有 {formatNum(unknownSessionRecords)} 条记录{typeof unknownSessionTokens === 'number' ? `（${formatTokens(unknownSessionTokens)} 有效 Token）` : ''}缺少会话 ID，未计入会话数与本排行；这些记录仍计入上方 Token、记录数与各图表。</p>}
            </div>
            {/* The live region exists before its text (review F3): a region inserted
                together with its text is announced unreliably, and focus stays on
                the pressed 逐轮分析 button. Empty, it takes no space. */}
            <div className="behavior-rank-live" role="status">{sessionAnalysis.failure && <p className="behavior-rank-note is-attention">{sessionAnalysis.failure}</p>}</div>
            {data.sessions.length === 0
              ? <p className="behavior-rank-empty">该区间没有带会话 ID 的记录。</p>
              : <ol className={`behavior-rank-list tl-scrollbar${sessionActions ? ' has-actions' : ''}${showSessionProject ? ' has-projects' : ''}`} role="list" aria-labelledby={sessionRankTitleId}>{data.sessions.map(session => {
                const key = behaviorSessionKey(session);
                const span = formatBehaviorSessionSpan(session.firstAt, session.lastAt, referenceYear);
                const cost = formatBehaviorSessionCost(session.cost);
                const locating = sessionAnalysis.locatingKey === key;
                return <li className="behavior-rank-row" key={key}>
                  <RankRowMain onActivate={openSession ? () => openSession({ id: session.id, tool: session.tool }) : undefined} title={session.id} action="查看该会话明细">
                    <span className="behavior-rank-name"><span className="entity-dot" style={{ color: toolColorAssignment.get(session.tool.toLowerCase()) ?? colorForTool(session.tool, 0, effective) }} aria-hidden="true" /><span>{session.id}</span></span>
                    <strong className="behavior-rank-value">{formatTokens(session.tokens)}<span className="sr-only"> 有效 Token</span></strong>
                    <span className="behavior-rank-meta">{[session.tool, formatBehaviorTopModel(session.topModel), span, `${formatNum(session.requests)} 条记录`].filter(Boolean).join(' · ')}</span>
                    <span className={`behavior-rank-aside${cost === '不可得' ? ' is-unavailable' : ''}`}><span className="sr-only">会话预估费用</span>{cost}</span>
                  </RankRowMain>
                  {showSessionProject && (
                    <SessionProjectChip
                      project={session.project}
                      reason={session.projectReason}
                      aliases={projectAliases}
                      hidden={hideProjectNames}
                      onSelect={(key) => onProjectFilterChange?.([key])}
                    />
                  )}
                  {supportsBehaviorSessionAnalysis(session.tool)
                    ? <button type="button" className="behavior-rank-action" aria-busy={locating || undefined} onClick={() => { if (!locating) void sessionAnalysis.open(session); }}><ListTree size={15} aria-hidden="true" />{locating ? '定位中…' : '逐轮分析'}<span className="sr-only">：会话 {session.id}</span></button>
                    : sessionActions ? <span className="behavior-rank-action-slot" aria-hidden="true" /> : null}
                </li>;
              })}</ol>}
          </div>
        </div>
        <div className="panel behavior-request-sizes">
          <div className="workbuddy-card-header"><h2>账本记录大小分布</h2><label>模型 <select aria-label="记录大小模型" value={currentRequestModel?.model || ''} onChange={event => setSelectedModel(event.target.value)}>{data.requestSizes.map(item => <option key={item.model} value={item.model}>{item.model}</option>)}</select></label></div>
          {currentRequestModel && <><p className="behavior-percentile-copy">{formatNum(currentRequestModel.requests)} 条记录 · P50 {formatTokens(currentRequestModel.p50)} · P90 {formatTokens(currentRequestModel.p90)} · 最大 {formatTokens(currentRequestModel.max)}<InfoTip label="记录大小说明">部分来源按会话记录，一条记录可能对应一个会话。</InfoTip></p><div className="behavior-chart"><EChart option={requestSizeOption} ariaLabel="所选模型账本记录大小分布" /></div></>}
        </div>
      </>}
      <p className="behavior-coverage-note">本机覆盖：{data.meta.firstRecordAt || '暂无记录'} 至 {data.meta.lastRecordAt || '暂无记录'}<InfoTip label="覆盖范围说明">云端能力边界：行为分析不会从云端有限 history 推断全量。</InfoTip></p>
    </>}
    {sessionAnalysis.record && <Suspense fallback={null}><SessionAnalysisDrawer record={sessionAnalysis.record} onClose={sessionAnalysis.close} /></Suspense>}
  </section>;
}

export default BehaviorAnalysisView;
