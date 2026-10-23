import { useCallback, useEffect, useState } from 'react';
import type { DetailFilters } from '../components/LogsTable';
import type { CustomDateRange, DataScope, RangeKey, Tab } from '../types';
import { isoCalendarDayValue } from '../utils/frontendContracts';
import { formatCustomRangeLabel } from '../utils/rangeDisplay';
import { EMPTY_DETAIL_FILTERS } from './useUsageDetails';

/**
 * 总览的“查看当日明细”（审计 P0-1）。明细搜索只匹配工具、模型、设备与会话
 * （dashboard-stats-v2 §4.1），把日期塞进搜索永远是 0 条。正确做法与行为页一致：
 * 切到该日的单日自定义范围并清空筛选；同时记住原范围、筛选与来源页，明细页
 * 据此给出“返回”，恢复后回到来源页。用户自己改了范围或筛选，记忆立即作废。
 *
 * 作用域（T10.185）：桌面云端自 T10.113 起已接通自定义范围（含单日），两个作用域
 * 都能表达单日复盘，`dayDrillUnavailable` 因此不再按作用域拦截，恒为 null。
 * `leaveForScope` 保留导出（`App.tsx` 仍在切换作用域前调用），但退出某次复盘的
 * 内部实现（评审 P3-4 之前的 `leave`/`stranded`/`dayDrillScopeExitNotice`）已删除：
 * 两个作用域都表达得了单日，这条路径从未被真实触发过。`leaveForScope` 因此恒为
 * 空操作、恒返回 false；接口不变，调用方无需跟着改。旧服务器仍拒绝 custom 时，
 * 走的是加载失败的诚实降级（`classifyCloudFailure` 的 `range-unsupported`／
 * 「云端范围受限」），不是这里的预检。
 */

export interface DayDrillOrigin {
  /** 下钻时的数据作用域；返回或退出时据此决定设备筛选能否恢复。 */
  scope: DataScope;
  tab: Tab;
  range: RangeKey;
  customRange: CustomDateRange | null;
  filters: DetailFilters;
}

export interface DayDrill {
  /** 被复盘的本地日期 `YYYY-MM-DD`。 */
  date: string;
  origin: DayDrillOrigin;
}

/** 下钻入口不可用时的说明：`label` 就地显示，`description` 用于悬停提示与读屏。 */
export interface DayDrillUnavailable {
  label: string;
  description: string;
}

/**
 * T10.185: no desktop scope refuses a single day any more (cloud custom
 * ranges, single-day included, have worked since T10.113's migration). Kept
 * as a function — rather than inlining `null` at each call site — so a
 * future scope that genuinely cannot express a day has one place to report
 * that from; it always returns null today.
 */
export function dayDrillUnavailable(_scope: DataScope): DayDrillUnavailable | null {
  return null;
}

/** 当前查询是否仍是这次下钻设下的单日范围与空筛选；任何偏离都视为用户改了条件。 */
export function isDayDrillQuery(
  drill: DayDrill,
  range: RangeKey,
  customRange: CustomDateRange | null,
  filters: DetailFilters,
): boolean {
  return range === 'custom'
    && customRange?.start === drill.date
    && customRange.end === drill.date
    && filters.tools.length === 0
    && filters.models.length === 0
    && filters.machines.length === 0
    && filters.search === '';
}

const RETURN_RANGE_LABELS: Record<Exclude<RangeKey, 'custom'>, string> = {
  today: '今日',
  week: '本周',
  month: '本月',
  year: '今年',
  all: '全部',
};

const ORIGIN_TAB_LABELS: Record<Tab, string> = {
  dashboard: '概览',
  behavior: '会话',
  logs: '请求',
  allowances: '额度',
  settings: '设置',
  agents: 'Agent',
  providers: '供应商',
  gateway: '网关',
  routing: '路由',
};

export interface DayDrillCopy {
  /** “9月12日”；不在今年时带年份。 */
  day: string;
  /** 来源页，如“总览”。 */
  origin: string;
  /** 按钮文字，如“返回本月”。 */
  returnLabel: string;
  /** 按钮的完整可访问名称；以可见文字开头（WCAG 2.5.3）。 */
  returnAriaLabel: string;
}

function drillDayLabel(date: string, now: Date): string {
  const [year, month, day] = date.split('-').map(Number);
  return year === now.getFullYear() ? `${month}月${day}日` : `${year}年${month}月${day}日`;
}

function originRangeLabel({ range, customRange }: DayDrillOrigin): string {
  if (range !== 'custom') return RETURN_RANGE_LABELS[range];
  return customRange ? formatCustomRangeLabel(customRange.start, customRange.end) : '原范围';
}

export function dayDrillCopy(drill: DayDrill, now: Date = new Date()): DayDrillCopy {
  const rangeLabel = originRangeLabel(drill.origin);
  const origin = ORIGIN_TAB_LABELS[drill.origin.tab];
  return {
    day: drillDayLabel(drill.date, now),
    origin,
    returnLabel: `返回${rangeLabel}`,
    returnAriaLabel: `返回${rangeLabel}：回到${origin}并恢复原筛选`,
  };
}

/**
 * 返回或退出时恢复的筛选。设备筛选只在各自作用域里有意义：切换作用域时
 * useStats 会清空它，这里不把来源作用域的设备带过去（评审 P2-1）。
 */
export function originFiltersFor(origin: DayDrillOrigin, scope: DataScope): DetailFilters {
  return origin.scope === scope ? origin.filters : { ...origin.filters, machines: [] };
}

/** 懒加载的目标页可能还没挂载；最多等 60 帧再放弃，避免焦点落回 BODY。 */
function focusWhenMounted(resolve: () => HTMLElement | null) {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;
  let attempts = 0;
  const attempt = () => {
    const element = resolve();
    if (element) {
      element.focus({ preventScroll: true });
      return;
    }
    if (attempts < 60) {
      attempts += 1;
      window.requestAnimationFrame(attempt);
    }
  };
  window.requestAnimationFrame(attempt);
}

export interface UseDayDrillProps {
  scope: DataScope;
  activeTab: Tab;
  range: RangeKey;
  customRange: CustomDateRange | null;
  filters: DetailFilters;
  changeRange: (range: RangeKey, bounds?: CustomDateRange | null) => void;
  setFilters: (filters: DetailFilters) => void;
  changeTab: (tab: Tab, reset?: boolean) => void;
  /** 复盘因作用域容不下单日范围而退出时的提示，App 用 toast 显示。 */
  onScopeExit?: (notice: string) => void;
}

export function useDayDrill({
  scope,
  activeTab,
  range,
  customRange,
  filters,
  changeRange,
  setFilters,
  changeTab,
}: UseDayDrillProps) {
  const [drill, setDrill] = useState<DayDrill | null>(null);
  const matching = drill && isDayDrillQuery(drill, range, customRange, filters) ? drill : null;
  const active = matching;

  useEffect(() => {
    // The user changed the range or a filter: the remembered origin is stale.
    // Drop it for good, so undoing the change by hand does not resurrect it.
    if (drill && !matching) setDrill(null);
  }, [drill, matching]);

  const unavailable = dayDrillUnavailable(scope);

  /** `entity`：从只看某个 Agent 或模型的热力图点进来时，明细同时按它筛选，结果与格子一致。 */
  const drillIntoDay = useCallback((date: string, entity?: Pick<DetailFilters, 'tools' | 'models'>) => {
    // Never navigate to a result the scope cannot produce; the entry points
    // are rendered disabled with the reason instead.
    if (unavailable || isoCalendarDayValue(date) === null) return false;
    // A second drill keeps the first origin, so "back" still leads home.
    const origin = active?.origin ?? { scope, tab: activeTab, range, customRange, filters };
    setDrill({ date, origin });
    changeRange('custom', { start: date, end: date });
    setFilters(entity ? { ...EMPTY_DETAIL_FILTERS, tools: entity.tools, models: entity.models } : EMPTY_DETAIL_FILTERS);
    changeTab('logs', true);
    focusWhenMounted(() => document.getElementById('details-page-title'));
    return true;
  }, [active, activeTab, changeRange, changeTab, customRange, filters, range, scope, setFilters, unavailable]);

  /**
   * T10.185 review P3-4: kept exported because `App.tsx` still calls this
   * right before switching scope. No desktop scope has refused a single day
   * since T10.113, so this is now a stable no-op (always `false`, the review
   * is never ended here) — the removed fallback (`leave`/`stranded`/
   * `dayDrillScopeExitNotice`) handled "the new scope can't express this
   * day", which can no longer happen. See the module doc comment.
   */
  const leaveForScope = useCallback((_nextScope: DataScope) => false, []);

  const returnFromDayDrill = useCallback(() => {
    if (!active) return;
    const { origin } = active;
    setDrill(null);
    changeRange(origin.range, origin.customRange);
    setFilters(originFiltersFor(origin, scope));
    changeTab(origin.tab);
    // The return button unmounts with the details page; keep keyboard focus
    // in the content region instead of letting it fall back to BODY.
    focusWhenMounted(() => document.getElementById('main-content'));
  }, [active, changeRange, changeTab, scope, setFilters]);

  return {
    dayDrill: active,
    dayDrillUnavailable: unavailable,
    drillIntoDay,
    leaveForScope,
    returnFromDayDrill,
  };
}
