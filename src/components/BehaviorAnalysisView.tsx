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
import { localized, t, useLang, type MessageKey } from '../i18n';

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

const RANGE_OPTION_KEYS: Array<[QuickRange, MessageKey]> = [['today', 'behavior.range.today'], ['threeDays', 'behavior.range.threeDays'], ['sevenDays', 'behavior.range.sevenDays'], ['thirtyDays', 'behavior.range.thirtyDays']];
const rangeOptions = (): Array<[QuickRange, string]> => RANGE_OPTION_KEYS.map(([id, key]) => [id, t(key)]);

// Presets follow the dashboard's calendar meaning (contract v1.1): this week
// from Monday, this month from the 1st, this year from January 1st. They are
// named, never described as "近 7/30/365 天".
const PRESET_NAMES = localized<Exclude<RangeKey, 'custom'>>({ today: 'behavior.range.today', week: 'behavior.preset.week', month: 'behavior.preset.month', year: 'behavior.preset.year', all: 'behavior.preset.all' });


/** Host-local calendar day `YYYY-MM-DD`: the quick picks are host-local day counts. */
function hostDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** The page's name for the current selection; dates come from `meta.start/end`. */
function behaviorRangeName(range: RangeKey, preset: string): string {
  if (range !== 'custom') return PRESET_NAMES[range];
  return rangeOptions().find(([id]) => id === preset)?.[1] ?? t('behavior.customRange');
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
  return customRange ? t('behavior.rangeSpan', { start: customRange.start, end: customRange.end }) : t('behavior.customRange');
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
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return t('behavior.unavailable');
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
  if (tool.sessionCount === 0 && (unknown > 0 || tool.requests > 0)) return t('behavior.sessionsUnknown');
  if (unknown > 0) return t('behavior.sessionsPartial', { count: formatNum(tool.sessionCount), unknown: formatNum(unknown) });
  return t('behavior.sessions', { count: formatNum(tool.sessionCount) });
}

/** A session's top model; an explicit null (or empty name) is 「不可得」, an absent field (older backend) says nothing. */
export function formatBehaviorTopModel(topModel: string | null | undefined): string | null {
  if (topModel === undefined) return null;
  return topModel && topModel.trim() ? topModel : t('behavior.topModelUnavailable');
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
    <span className="sr-only">{t('behavior.actionSr', { action })}</span>
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

type RefreshAnnouncement =
  | { kind: 'refreshing' }
  | { kind: 'failed'; time: string | null }
  | { kind: 'refreshed'; time: string | null }
  | null;

function refreshAnnouncementText(note: RefreshAnnouncement): string {
  if (!note) return '';
  if (note.kind === 'refreshing') return t('behavior.refreshing');
  if (note.kind === 'failed') return note.time ? t('behavior.refreshFailedAt', { time: note.time }) : t('behavior.refreshFailedLast');
  return t('behavior.refreshedAt', { time: note.time ?? t('behavior.justNow') });
}

export function BehaviorAnalysisView({ hasPageTitle = false, data: dataProp, loading, refreshing = false, updatedAt = null, error, scope, range, customRange, onRangeChange, onRetry, onViewLocal, onSelectDate, onOpenTool, onOpenSession, projectFilter = [], onProjectFilterChange, onOpenProjectSettings, onRebuildProjectIndex, projectBackfill = null, ledgerEmpty = false, onScan, scanBusy = false }: Props) {
  const lang = useLang();
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
  // data.tools arrives ranked by effective tokens desc (t('behavior.toolRankInfo'));
  // resolve same-slot collisions once by that rank, and share the one
  // resulting map with the session-ranking list below so the same tool reads
  // the same colour in both lists on this page (T10.178 review P1-1). `effective`
  // must be in the dependency array or a theme toggle leaves stale colours on
  // screen until some unrelated re-render happens to recompute them (P2-1).
  const toolColorAssignment = useMemo(
    () => toolColorMap((data?.tools || []).map((item) => item.id), effective),
    [data, effective],
  );
  // 「其他模型」既是图例名也是序列键，随界面语言换。
  const otherModels = t('behavior.otherModels', undefined, lang);
  const modelDayOption = useMemo(() => {
    const totals = sumBy(data?.modelDays || [], row => row.model, row => row.tokens);
    const topModels = [...totals.keys()].sort((a, b) => (totals.get(b) || 0) - (totals.get(a) || 0)).slice(0, 6);
    const topSet = new Set(topModels);
    const byDateModel = sumBy(data?.modelDays || [], row => `${row.date}|${topSet.has(row.model) ? row.model : otherModels}`, row => row.tokens);
    const models = totals.size > topModels.length ? [...topModels, otherModels] : topModels;
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
  }, [chartTheme, data, visibleDates, palette, windowKey, otherModels]);
  const modelHourOption = useMemo(() => {
    const totals = sumBy(data?.modelHours || [], row => row.model, row => row.tokens);
    const topModels = [...totals.keys()].sort((a, b) => (totals.get(b) || 0) - (totals.get(a) || 0)).slice(0, 6);
    const topSet = new Set(topModels);
    const byHourModel = sumBy(data?.modelHours || [], row => `${row.hour}|${topSet.has(row.model) ? row.model : otherModels}`, row => row.tokens);
    const models = totals.size > topModels.length ? [...topModels, otherModels] : topModels;
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
  }, [chartTheme, data, palette, windowKey, otherModels]);
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
      rangeTruncated ? t('behavior.coverage.truncated', { name: rangeName, days: formatNum(rangeDayLimit) }) : rangeName,
      data.meta.start === data.meta.end ? data.meta.start : t('behavior.rangeSpan', { start: data.meta.start, end: data.meta.end }),
      t('behavior.coverage.records', { count: data.meta.recordCount.toLocaleString() }),
    ].join(' · ')
    : t('behavior.coverage.default', { name: rangeName });
  // Records whose source carries no session ID are real usage but not a
  // session (contract v1.1). A missing field means an older backend: no note.
  const unknownSessionRecords = data?.summary.unknownSessionRecords ?? 0;
  const unknownSessionTokens = data?.summary.unknownSessionTokens;
  // With every record lacking a session ID the session count is unknown, not 0.
  // The same rule as a tool row: an older backend without the unknown count
  // still reports records but no session.
  const sessionsUnknown = Boolean(data && data.summary.sessionCount === 0 && (unknownSessionRecords > 0 || data.summary.requests > 0));
  const sessionCountLabel = sessionsUnknown ? t('behavior.unavailable') : formatNum(data?.summary.sessionCount ?? 0);
  const sessionCountNote = unknownSessionRecords > 0
    ? t(sessionsUnknown ? 'behavior.sessionNote.all' : 'behavior.sessionNote.more', { count: formatNum(unknownSessionRecords) })
    : sessionsUnknown ? t('behavior.sessionNote.unknown') : null;
  const busy = loading || refreshing || rangeSwitchPending;
  const receivedAt = formatReceivedAt(updatedAt);
  // Only a refresh the user asked for is announced (review F4). Background
  // refreshes after a scan or sync change the visible status text quietly, and
  // a first failure is announced by the alert banner instead.
  // Kept as a state, not a sentence, so a language switch mid-refresh still compares and re-renders correctly.
  const [refreshAnnouncement, setRefreshAnnouncement] = useState<RefreshAnnouncement>(null);
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
      setRefreshAnnouncement(current => (current?.kind === 'refreshing' ? current : null));
    } else if (finished && error) {
      // Cleared only when this refresh ends in failure. A first failure is told
      // by the new banner; a manual retry that fails again leaves the banner
      // unchanged, so role="alert" says nothing and this region has to.
      setRefreshAnnouncement(current => (current?.kind === 'refreshing' && failedBefore.current && hasResult ? { kind: 'failed', time: receivedAt ?? null } : null));
    } else if (finished) setRefreshAnnouncement(current => (current?.kind === 'refreshing' ? { kind: 'refreshed', time: receivedAt ?? null } : current));
  }, [busy, error, receivedAt, hasResult]);
  const referenceYear = data ? Number(data.meta.end.slice(0, 4)) : undefined;
  const sessionActions = Boolean(data?.sessions.some(session => supportsBehaviorSessionAnalysis(session.tool)));
  const showSessionProject = behaviorShowsSessionProject(data);
  const projectAliases = useMemo(
    () => behaviorProjectAliases(data, hideProjectNames),
    // 代称文案随界面语言变化，lang 只用来触发重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, hideProjectNames, lang],
  );
  // Drill-downs decide at press time whether the current range still covers
  // the analysed window (for example after midnight it no longer does).
  const openTool = onOpenTool && analysedWindow
    ? (tool: string) => onOpenTool(tool, behaviorDrillRange(analysedWindow))
    : undefined;
  const openSession = onOpenSession && analysedWindow
    ? (session: BehaviorSessionRef) => onOpenSession({ session, filters: behaviorSessionDetailFilters(session), range: behaviorDrillRange(analysedWindow) })
    : undefined;
  if (scope === 'cloud') return <section className="content-stack behavior-analysis-view"><div className="panel empty-panel"><Database className="h-5 w-5" /><div>{hasPageTitle ? <h2>{t('behavior.cloud.title')}</h2> : <h1>{t('behavior.cloud.title')}</h1>}<p>{t('behavior.cloud.body')}</p><button className="primary-inline" type="button" onClick={onViewLocal}>{t('behavior.cloud.viewLocal')}</button></div></div></section>;
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
      <div className="segmented tl-seg behavior-range-segmented" role="group" aria-label={t('behavior.rangeAria')} ref={rangeSegRef}>
        {rangeOptions().map(([id, label]) => <button key={id} type="button" className={!showCustomRange && preset === id ? 'active' : ''} aria-pressed={!showCustomRange && preset === id} onClick={() => choosePreset(id)}>{label}</button>)}
        <button type="button" className={showCustomRange ? 'active' : ''} aria-pressed={showCustomRange} onClick={() => setCustomExpanded(true)}>{t('behavior.custom')}</button>
      </div>
      {showCustomRange && <form className="behavior-custom-range" aria-label={t('behavior.customFormAria')} onSubmit={event => { event.preventDefault(); if (draftStart && draftEnd && !invalidDraftRange) onRangeChange('custom', { start: draftStart, end: draftEnd }); }}>
        <CalendarDays className="h-4 w-4" aria-hidden="true" />
        <input aria-label={t('behavior.customStart')} type="date" required aria-invalid={invalidDraftRange || undefined} aria-describedby={invalidDraftRange ? rangeErrorId : undefined} value={draftStart} onChange={event => setDraftStart(event.target.value)} />
        <span>{t('behavior.to')}</span>
        <input aria-label={t('behavior.customEnd')} type="date" required aria-invalid={invalidDraftRange || undefined} aria-describedby={invalidDraftRange ? rangeErrorId : undefined} value={draftEnd} onChange={event => setDraftEnd(event.target.value)} />
        <button type="submit" className="behavior-apply-range" disabled={!draftStart || !draftEnd || invalidDraftRange}>{t('behavior.applyRange')}</button>
      </form>}
    </div>
    <div className="page-heading behavior-analysis-heading">
      {/* U-102：范围与记录数已在范围栏和指标卡里，口径行收进 ⓘ。 */}
      <div className="behavior-heading-info">{!hasPageTitle && <h1 className="sr-only">{t('behavior.title')}</h1>}{data && <span className="behavior-applied-range">{t('behavior.applied', { start: data.meta.start, end: data.meta.end })}</span>}<InfoTip label={t('behavior.scopeInfo')}><span>{coverage}</span><span>{t('behavior.tokenDef')}</span></InfoTip>{heldRangeNotice && <p className="page-subtitle" role="status">{heldRangeNotice}</p>}</div>
      <div className="behavior-refresh">
        {/* Text, not only the spinner, carries the state: reduced motion stops the spin. */}
        {/* 刷新中的文字要看得见（reduced motion 下不转圈）；完成后的「更新于」与顶栏重复，只留给读屏（U-102）。 */}
        <span className="behavior-refresh-status">{refreshing ? t('behavior.refreshing') : !loading && receivedAt ? <time className="sr-only" dateTime={updatedAt ?? undefined}>{t('behavior.updatedAt', { time: receivedAt })}</time> : null}</span>
        <span className="sr-only" role="status">{refreshAnnouncementText(refreshAnnouncement)}</span>
        {/* aria-disabled keeps keyboard focus on the button while it works; a
            repeated press is ignored and the shown result stays on screen. */}
        <button className="ghost-inline behavior-refresh-button" type="button" aria-disabled={busy || undefined} onClick={() => { if (!busy) { setRefreshAnnouncement({ kind: 'refreshing' }); onRetry(); } }}><RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />{t('behavior.refresh')}</button>
      </div>
    </div>
    {showCustomRange && invalidDraftRange && <p id={rangeErrorId} className="behavior-range-error" role="alert">{t('behavior.rangeError')}</p>}
    {rangeTruncated && data && <p className="behavior-range-note"><Info className="h-4 w-4" aria-hidden="true" /><span>{t('behavior.allTruncated', { days: formatNum(rangeDayLimit), start: data.meta.start })}</span></p>}
    {/* A failed refresh keeps the previous result on screen; say it is not the latest. */}
    {/* One text column (review F5): the banner spreads its direct children apart. */}
    {error && <div className="cloud-recovery-banner" role="alert"><div><strong>{t('behavior.readFailed')}</strong><span>{error}</span>{data && <span>{receivedAt ? t('behavior.staleAt', { time: receivedAt }) : t('behavior.staleLast')}</span>}</div></div>}
    {loading && !data ? <div className="panel behavior-loading" role="status">{t('behavior.loading')}</div> : data && <>
      <div className="behavior-summary-grid">{([
        [t('behavior.stat.tokens'), formatTokens(data.summary.tokens), Activity, null],
        [t('behavior.stat.records'), formatNum(data.summary.requests), Server, null],
        [t('behavior.stat.activeDays'), formatNum(data.summary.activeDays), CalendarDays, null],
        [t('behavior.stat.sessions'), sessionCountLabel, Users, sessionCountNote],
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
        <div className="behavior-day-pager" aria-label={t('behavior.dayPagerAria')}>
          <span>{t('behavior.dayPager', { first: visibleDates[0], last: visibleDates[visibleDates.length - 1], days: dates.length })}</span>
          <button type="button" disabled={dayOffset + 14 >= dates.length} onClick={() => setDayOffset(offset => Math.min(dates.length - 14, offset + 14))}>{t('behavior.earlier')}</button>
          <button type="button" disabled={dayOffset === 0} onClick={() => setDayOffset(offset => Math.max(0, offset - 14))}>{t('behavior.later')}</button>
        </div>
        <div className="behavior-chart-grid">
          <div className="panel behavior-chart-card">
            <div className="workbuddy-card-header"><h2>{selectedHour === null ? t('behavior.daily') : t('behavior.dailyAt', { hour: selectedHour })}<InfoTip label={t('behavior.dailyInfoLabel')}>{t('behavior.dailyInfo')}</InfoTip></h2></div>
            <div className="behavior-chart"><EChart option={dayOption} ariaLabel={t('behavior.dailyAria')} onEvents={{ click: (params: { name?: string }) => { if (params.name) setSelectedDate(params.name); } }} /></div>
          </div>
          <div className="panel behavior-chart-card">
            <div className="workbuddy-card-header"><h2>{t('behavior.hourly')}<InfoTip label={t('behavior.hourlyInfoLabel')}>{t('behavior.hourlyInfo')}</InfoTip></h2>{selectedHour !== null && <span>{t('behavior.hourSelected', { hour: selectedHour })}</span>}</div>
            <div className="behavior-chart"><EChart option={hourOption} ariaLabel={t('behavior.hourlyAria')} onEvents={{ click: (params: { dataIndex?: number }) => setSelectedHour(typeof params.dataIndex === 'number' ? params.dataIndex : null) }} /></div>
          </div>
        </div>
        <div className="behavior-selection-bar">
          <label>{t('behavior.pickDate')} <select aria-label={t('behavior.pickDateAria')} value={selectedDateValue} onChange={event => setSelectedDate(event.target.value || null)}><option value="">{t('behavior.pickDatePlaceholder')}</option>{dates.map(date => <option key={date} value={date}>{date}</option>)}</select></label>
          <button type="button" disabled={!selectedDateValue} onClick={() => selectedDateValue && onSelectDate?.(selectedDateValue)}>{t('behavior.viewDay')}</button>
          {selectedHour !== null && <button type="button" onClick={() => setSelectedHour(null)}>{t('behavior.clearHour')}</button>}
        </div>
        <div className="behavior-chart-grid">
          <div className="panel behavior-chart-card">
            <div className="workbuddy-card-header"><h2>{t('behavior.heatmap')}<InfoTip label={t('behavior.heatmapInfoLabel')}>{t('behavior.heatmapInfo')}</InfoTip></h2></div>
            <div className="behavior-heatmap-scroll" role="region" aria-label={t('behavior.heatmapAria')} tabIndex={0}>
              <div className="behavior-heatmap-grid">
                <div className="behavior-heatmap-corner" aria-hidden="true" />
                {Array.from({ length: 24 }, (_, hour) => <span className="behavior-heatmap-hour" key={hour}>{hour % 3 === 0 ? hour : ''}</span>)}
                {visibleDates.map(date => <div className="behavior-heatmap-row" key={date}>
                  <span className="behavior-heatmap-date">{date.slice(5)}</span>
                  {Array.from({ length: 24 }, (_, hour) => {
                    const tokens = heatValues.get(`${date}|${hour}`) || 0;
                    const level = tokens === 0 ? 0 : Math.max(1, Math.ceil(tokens / heatPeak * 5));
                    const selected = selectedDate === date && selectedHour === hour;
                    return <button key={hour} type="button" className="behavior-heatmap-cell" data-level={level} aria-pressed={selected} aria-label={t('behavior.cellAria', { date, hour, tokens: formatTokens(tokens) })} title={`${date} ${hour}:00 · ${formatTokens(tokens)}`} onClick={() => { setSelectedDate(date); setSelectedHour(hour); }} />;
                  })}
                </div>)}
              </div>
            </div>
          </div>
          <div className="panel behavior-chart-card"><div className="workbuddy-card-header"><h2>{t('behavior.modelDaily')}<InfoTip label={t('behavior.modelDailyInfoLabel')}>{t('behavior.modelDailyInfo')}</InfoTip></h2></div><div className="behavior-chart"><EChart option={modelDayOption} ariaLabel={t('behavior.modelDaily')} onEvents={{ click: (params: { name?: string }) => { if (params.name) setSelectedDate(params.name); }, legendselectchanged: (params: { selected?: unknown }) => rememberLegend('modelDay', params.selected) }} /></div></div>
        </div>
        <div className="panel behavior-chart-card"><div className="workbuddy-card-header"><h2>{t('behavior.modelHourly')}<InfoTip label={t('behavior.modelHourlyInfoLabel')}>{t('behavior.modelHourlyInfo')}</InfoTip></h2></div><div className="behavior-chart"><EChart option={modelHourOption} ariaLabel={t('behavior.modelHourly')} onEvents={{ click: (params: { dataIndex?: number }) => setSelectedHour(typeof params.dataIndex === 'number' ? params.dataIndex : null), legendselectchanged: (params: { selected?: unknown }) => rememberLegend('modelHour', params.selected) }} /></div></div>
        <div className="behavior-detail-grid">
          <div className="panel behavior-rank-panel">
            <div className="behavior-rank-head">
              <h2 id={toolRankTitleId}>{t('behavior.toolRank')} <small>{t('behavior.toolCount', { count: data.tools.length })}</small></h2>
              <InfoTip label={t('behavior.toolRankInfoLabel')}>{t('behavior.toolRankInfo')}{openTool ? t('behavior.toolRankInfoOpen') : ''}</InfoTip>
            </div>
            <ol className="behavior-rank-list tl-scrollbar" role="list" aria-labelledby={toolRankTitleId}>{data.tools.map((item) => <li className="behavior-rank-row" key={item.id}>
              <RankRowMain onActivate={openTool ? () => openTool(item.id) : undefined} title={openTool ? t('behavior.openToolTitle', { tool: item.id }) : undefined} action={t('behavior.openTool')}>
                <span className="behavior-rank-name"><span className="entity-dot" style={{ color: toolColorAssignment.get(item.id.toLowerCase()) ?? colorForTool(item.id, 0, effective) }} aria-hidden="true" /><span>{item.id}</span></span>
                <strong className="behavior-rank-value">{formatTokens(item.tokens)}<span className="sr-only">{t('behavior.tokensSr')}</span></strong>
                <span className="behavior-rank-meta">{t('behavior.recordCount', { count: formatNum(item.requests) })} · {formatBehaviorToolSessions(item)}</span>
              </RankRowMain>
            </li>)}</ol>
          </div>
          <div className="panel behavior-rank-panel">
            <div className="behavior-rank-head">
              <h2 id={sessionRankTitleId}>{t('behavior.sessionRank')} <small>{data.meta.sessionsTruncated ? t('behavior.sessionTop', { count: formatNum(data.meta.sessionLimit) }) : t('behavior.sessionCount', { count: data.sessions.length })}</small></h2>
              <InfoTip label={t('behavior.sessionRankInfoLabel')}>{t('behavior.sessionRankInfo')}{openSession ? t('behavior.sessionRankInfoOpen') : ''}</InfoTip>
              {unknownSessionRecords > 0 && <p className="behavior-rank-note">{typeof unknownSessionTokens === 'number' ? t('behavior.unknownSessionsTokens', { count: formatNum(unknownSessionRecords), tokens: formatTokens(unknownSessionTokens) }) : t('behavior.unknownSessions', { count: formatNum(unknownSessionRecords) })}</p>}
            </div>
            {/* The live region exists before its text (review F3): a region inserted
                together with its text is announced unreliably, and focus stays on
                the pressed 逐轮分析 button. Empty, it takes no space. */}
            <div className="behavior-rank-live" role="status">{sessionAnalysis.failure && <p className="behavior-rank-note is-attention">{sessionAnalysis.failure}</p>}</div>
            {data.sessions.length === 0
              ? <p className="behavior-rank-empty">{t('behavior.noSessions')}</p>
              : <ol className={`behavior-rank-list tl-scrollbar${sessionActions ? ' has-actions' : ''}${showSessionProject ? ' has-projects' : ''}`} role="list" aria-labelledby={sessionRankTitleId}>{data.sessions.map(session => {
                const key = behaviorSessionKey(session);
                const span = formatBehaviorSessionSpan(session.firstAt, session.lastAt, referenceYear);
                const cost = formatBehaviorSessionCost(session.cost);
                const locating = sessionAnalysis.locatingKey === key;
                return <li className="behavior-rank-row" key={key}>
                  <RankRowMain onActivate={openSession ? () => openSession({ id: session.id, tool: session.tool }) : undefined} title={session.id} action={t('behavior.viewSession')}>
                    <span className="behavior-rank-name"><span className="entity-dot" style={{ color: toolColorAssignment.get(session.tool.toLowerCase()) ?? colorForTool(session.tool, 0, effective) }} aria-hidden="true" /><span>{session.id}</span></span>
                    <strong className="behavior-rank-value">{formatTokens(session.tokens)}<span className="sr-only">{t('behavior.tokensSr')}</span></strong>
                    <span className="behavior-rank-meta">{[session.tool, formatBehaviorTopModel(session.topModel), span, t('behavior.recordCount', { count: formatNum(session.requests) })].filter(Boolean).join(' · ')}</span>
                    <span className={`behavior-rank-aside${cost === t('behavior.unavailable') ? ' is-unavailable' : ''}`}><span className="sr-only">{t('behavior.sessionCostSr')}</span>{cost}</span>
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
                    ? <button type="button" className="behavior-rank-action" aria-busy={locating || undefined} onClick={() => { if (!locating) void sessionAnalysis.open(session); }}><ListTree size={15} aria-hidden="true" />{t(locating ? 'behavior.locating' : 'behavior.turns')}<span className="sr-only">{t('behavior.turnsSr', { id: session.id })}</span></button>
                    : sessionActions ? <span className="behavior-rank-action-slot" aria-hidden="true" /> : null}
                </li>;
              })}</ol>}
          </div>
        </div>
        <div className="panel behavior-request-sizes">
          <div className="workbuddy-card-header"><h2>{t('behavior.sizes')}</h2><label>{t('behavior.sizesModel')} <select aria-label={t('behavior.sizesModelAria')} value={currentRequestModel?.model || ''} onChange={event => setSelectedModel(event.target.value)}>{data.requestSizes.map(item => <option key={item.model} value={item.model}>{item.model}</option>)}</select></label></div>
          {currentRequestModel && <><p className="behavior-percentile-copy">{t('behavior.sizesCopy', { count: formatNum(currentRequestModel.requests), p50: formatTokens(currentRequestModel.p50), p90: formatTokens(currentRequestModel.p90), max: formatTokens(currentRequestModel.max) })}<InfoTip label={t('behavior.sizesInfoLabel')}>{t('behavior.sizesInfo')}</InfoTip></p><div className="behavior-chart"><EChart option={requestSizeOption} ariaLabel={t('behavior.sizesAria')} /></div></>}
        </div>
      </>}
      <p className="behavior-coverage-note">{t('behavior.coverageNote', { first: data.meta.firstRecordAt || t('behavior.noRecords'), last: data.meta.lastRecordAt || t('behavior.noRecords') })}<InfoTip label={t('behavior.coverageInfoLabel')}>{t('behavior.coverageInfo')}</InfoTip></p>
    </>}
    {sessionAnalysis.record && <Suspense fallback={null}><SessionAnalysisDrawer record={sessionAnalysis.record} onClose={sessionAnalysis.close} /></Suspense>}
  </section>;
}

export default BehaviorAnalysisView;
