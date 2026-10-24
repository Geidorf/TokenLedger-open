import type { BehaviorAnalysisResponse, DataScope, QuotaProviderEnvelope, QuotaWindowSnapshot, StatsData, ToolStat } from '../types';
import { summaryEffectiveTokens } from '../types';
import type { BudgetRule, BudgetLevel } from '../hooks/useBudget';
import { summaryCacheReuse } from '../components/usage/usageSummary';
import { toolDisplayName } from './toolDisplayName';
import { validateQuotaProviderEnvelopeStructure } from './contracts/quota';
import { providerDisplayName, quotaLevel, readQuotaWindow, type QuotaLevel } from './quotaOverview';

/**
 * 周报 / 月报：把一个已经结束（或进行中）的日历周、日历月和紧挨着的上一期并排汇总。
 *
 * 不新增任何口径：两期各读一次看板同一份 Stats v2（`range = 'custom'` 的本地日期闭区间），
 * 最贵的会话读「会话」页同一份行为分析，额度读额度页同一份快照，预算按设置页的规则在
 * 本期统计上复算（与 `src-tauri/src/budget.rs` 的 `used_for` 同一套取数）。
 * 本文件零 React 依赖，应用内视图、HTML/PDF 与图片导出共用它的结果。
 */

export type ReportKind = 'week' | 'month';

export interface ReportPeriod {
  kind: ReportKind;
  /** 本地日期闭区间 `YYYY-MM-DD`。 */
  start: string;
  end: string;
  /** false：本期还没结束，end 是今天，上一期按同样天数截取。 */
  complete: boolean;
  previousStart: string;
  previousEnd: string;
  /** 例如「10月13日—10月19日」「2026年9月」。 */
  label: string;
  previousLabel: string;
  /** 例如「上周」「本月」「2026年8月」。 */
  shortLabel: string;
}

const DAY_MS = 86_400_000;

function parseDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date));
}

function formatDay(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addDays(day: string, days: number): string {
  return formatDay(new Date(parseDay(day).getTime() + days * DAY_MS));
}

function daysBetween(start: string, end: string): number {
  return Math.round((parseDay(end).getTime() - parseDay(start).getTime()) / DAY_MS);
}

function minDay(left: string, right: string): string {
  return left < right ? left : right;
}

function zhDay(day: string, withYear = false): string {
  const [year, month, date] = day.split('-').map(Number);
  return withYear ? `${year}年${month}月${date}日` : `${month}月${date}日`;
}

function spanLabel(start: string, end: string, today: string): string {
  const withYear = start.slice(0, 4) !== today.slice(0, 4) || start.slice(0, 4) !== end.slice(0, 4);
  return start === end ? zhDay(start, withYear) : `${zhDay(start, withYear)}—${zhDay(end, withYear)}`;
}

/** 周一开始，与看板「本周」、预算周期一致。 */
export function weekStart(day: string): string {
  const weekday = (parseDay(day).getUTCDay() + 6) % 7;
  return addDays(day, -weekday);
}

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function shiftMonth(firstDay: string, months: number): string {
  const date = parseDay(firstDay);
  return formatDay(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1)));
}

function monthEnd(firstDay: string): string {
  return addDays(shiftMonth(firstDay, 1), -1);
}

/**
 * offset = 0 是包含今天的这一期，-1 是上一期，以此类推。进行中的一期与上一期比较同样天数
 * （本周到周三就比上周一到周三），已结束的一期比较完整的上一期。
 */
export function reportPeriod(kind: ReportKind, offset: number, today: string): ReportPeriod {
  const step = Math.min(0, Math.trunc(offset));
  let start: string;
  let fullEnd: string;
  let previousStart: string;
  let previousFullEnd: string;
  if (kind === 'week') {
    start = addDays(weekStart(today), step * 7);
    fullEnd = addDays(start, 6);
    previousStart = addDays(start, -7);
    previousFullEnd = addDays(start, -1);
  } else {
    start = shiftMonth(monthStart(today), step);
    fullEnd = monthEnd(start);
    previousStart = shiftMonth(start, -1);
    previousFullEnd = monthEnd(previousStart);
  }
  const complete = fullEnd < today;
  const end = complete ? fullEnd : today;
  const previousEnd = complete ? previousFullEnd : minDay(addDays(previousStart, daysBetween(start, end)), previousFullEnd);
  const monthName = (day: string) => {
    const [year, month] = day.split('-').map(Number);
    return year === Number(today.slice(0, 4)) ? `${month}月` : `${year}年${month}月`;
  };
  const label = kind === 'month' ? `${start.slice(0, 4)}年${Number(start.slice(5, 7))}月` : spanLabel(start, fullEnd, today);
  const previousLabel = kind === 'month'
    ? (complete ? monthName(previousStart) : `${monthName(previousStart)}同期`)
    : (complete ? '前一周' : '上周同期');
  const relative: Record<ReportKind, string[]> = { week: ['本周', '上周', '上上周'], month: ['本月', '上月'] };
  const shortLabel = relative[kind][-step] ?? (kind === 'week' ? `${zhDay(start)}起的一周` : monthName(start));
  return { kind, start, end, complete, previousStart, previousEnd, label, previousLabel, shortLabel };
}

/** 报告页的期次选择：从进行中的一期往前数 `count` 期。 */
export function reportPeriodOptions(kind: ReportKind, today: string, count = kind === 'week' ? 8 : 6): ReportPeriod[] {
  return Array.from({ length: count }, (_, index) => reportPeriod(kind, -index, today));
}

/** 默认打开上一期完整的周报 / 月报——每周一自动生成的也是这一期。 */
export const DEFAULT_REPORT_OFFSET = -1;

export type ReportDelta =
  | { kind: 'change'; percent: number }
  | { kind: 'new' }
  | { kind: 'flat' }
  | { kind: 'unavailable' };

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function compareValues(current: number | null, previous: number | null): ReportDelta {
  if (current === null || previous === null) return { kind: 'unavailable' };
  if (previous === 0) return current === 0 ? { kind: 'flat' } : { kind: 'new' };
  const percent = ((current - previous) / previous) * 100;
  return Math.abs(percent) < 0.05 ? { kind: 'flat' } : { kind: 'change', percent };
}

export function describeDelta(delta: ReportDelta): string | null {
  if (delta.kind === 'new') return '上期无记录';
  if (delta.kind === 'flat') return '持平';
  if (delta.kind === 'unavailable') return null;
  return `${delta.percent > 0 ? '+' : '−'}${Math.abs(delta.percent).toFixed(1)}%`;
}

export interface ReportTotals {
  effectiveTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  requests: number;
  /** 预估费用；来源给不出可信数时为 null，不显示成 $0。 */
  cost: number | null;
  /** 缓存复用率 0–1，与用量页同一算法；读写未拆分时为 null。 */
  cacheReuse: number | null;
  activeDays: number;
}

export interface ReportBreakdownRow {
  id: string;
  name: string;
  tokens: number;
  requests: number;
  cost: number | null;
  /** 占本期有效 Token 的比例 0–1。 */
  share: number | null;
  delta: ReportDelta;
}

export interface ReportSession {
  id: string;
  tool: string;
  model: string | null;
  tokens: number;
  requests: number;
  cost: number | null;
  firstAt: string | null;
  lastAt: string | null;
}

export interface ReportQuota {
  key: string;
  provider: string;
  window: string;
  remaining: number;
  level: QuotaLevel;
  stale: boolean;
  resetsAt: string | null;
}

export interface ReportBudget {
  id: string;
  rule: BudgetRule;
  used: number | null;
  percent: number | null;
  level: BudgetLevel;
}

export interface ReportDay {
  date: string;
  tokens: number;
}

export interface PeriodReport {
  period: ReportPeriod;
  scope: DataScope;
  generatedAt: string;
  totals: ReportTotals;
  previous: ReportTotals | null;
  deltas: {
    tokens: ReportDelta;
    cost: ReportDelta;
    requests: ReportDelta;
    /** 缓存复用率的百分点变化，null = 两期有一期不可得。 */
    cacheReusePoints: number | null;
  };
  days: ReportDay[];
  peakDay: ReportDay | null;
  agents: ReportBreakdownRow[];
  models: ReportBreakdownRow[];
  /** 按网关账号拆分（契约 §2.7）；本机没有网关记录或云端时为 null。 */
  accounts: ReportBreakdownRow[] | null;
  /** 按预估费用排序的最贵会话；云端或行为分析读不到时为 null。 */
  sessions: ReportSession[] | null;
  sessionsNote: string | null;
  quotas: ReportQuota[];
  budgets: ReportBudget[];
  highlights: string[];
}

export interface BuildPeriodReportInput {
  period: ReportPeriod;
  scope: DataScope;
  current: StatsData;
  previous: StatsData | null;
  behavior?: BehaviorAnalysisResponse | null;
  quotaProviders?: readonly QuotaProviderEnvelope[];
  quotaLabels?: ReportQuotaLabels;
  budgetRules?: readonly BudgetRule[];
  now?: Date;
  breakdownLimit?: number;
  sessionLimit?: number;
}

function knownCost(value: unknown): number | null {
  return finite(value) && value >= 0 ? value : null;
}

function inPeriod(day: string, start: string, end: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= start && day <= end;
}

function totalsFor(stats: StatsData, start: string, end: string): ReportTotals {
  const summary = stats.summary;
  const activeDays = Object.entries(stats.heatmap || {})
    .filter(([day, tokens]) => inPeriod(day, start, end) && finite(tokens) && tokens > 0).length;
  return {
    effectiveTokens: summaryEffectiveTokens(summary),
    inputTokens: summary.inputTokens || 0,
    outputTokens: summary.outputTokens || 0,
    cachedTokens: summary.cachedTokens || 0,
    requests: summary.totalRequests || 0,
    cost: knownCost(summary.totalCost),
    cacheReuse: summaryCacheReuse(summary),
    activeDays,
  };
}

type BreakdownSource = Pick<ToolStat, 'name' | 'requests'> & { input?: number; output?: number; cost?: number };

function rowTokens(row: { input?: number; output?: number }): number {
  return (row.input || 0) + (row.output || 0);
}

function breakdown(
  current: Record<string, BreakdownSource> | undefined,
  previous: Record<string, BreakdownSource> | undefined | null,
  effectiveTotal: number,
  displayName: (id: string) => string,
  limit: number,
): ReportBreakdownRow[] {
  const rows = Object.entries(current || {})
    .map(([id, row]) => {
      const tokens = rowTokens(row);
      const before = previous ? previous[id] : undefined;
      return {
        id,
        name: displayName(row.name || id),
        tokens,
        requests: row.requests || 0,
        cost: knownCost(row.cost),
        share: effectiveTotal > 0 ? tokens / effectiveTotal : null,
        delta: previous ? compareValues(tokens, before ? rowTokens(before) : 0) : { kind: 'unavailable' } as ReportDelta,
      };
    })
    .filter((row) => row.tokens > 0 || row.requests > 0)
    .sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name));
  if (rows.length <= limit) return rows;
  const head = rows.slice(0, limit - 1);
  const rest = rows.slice(limit - 1);
  const restTokens = rest.reduce((sum, row) => sum + row.tokens, 0);
  const restCosts = rest.map((row) => row.cost);
  return [...head, {
    id: '__other__',
    name: `其他 ${rest.length} 项`,
    tokens: restTokens,
    requests: rest.reduce((sum, row) => sum + row.requests, 0),
    cost: restCosts.every((cost) => cost !== null) ? restCosts.reduce<number>((sum, cost) => sum + (cost as number), 0) : null,
    share: effectiveTotal > 0 ? restTokens / effectiveTotal : null,
    delta: { kind: 'unavailable' },
  }];
}

function topSessions(behavior: BehaviorAnalysisResponse | null | undefined, limit: number): { sessions: ReportSession[] | null; note: string | null } {
  if (!behavior) return { sessions: null, note: null };
  const sessions = [...behavior.sessions]
    .map((session) => ({
      id: session.id,
      tool: toolDisplayName(session.tool),
      model: session.topModel ?? null,
      tokens: session.tokens,
      requests: session.requests,
      cost: knownCost(session.cost),
      firstAt: session.firstAt ?? null,
      lastAt: session.lastAt ?? null,
    }))
    // 费用可得的按费用排；费用不可得的排在后面按 Token 排，不当成 $0 混进前面。
    .sort((left, right) => {
      if (left.cost !== null && right.cost !== null && left.cost !== right.cost) return right.cost - left.cost;
      if ((left.cost === null) !== (right.cost === null)) return left.cost === null ? 1 : -1;
      return right.tokens - left.tokens || left.id.localeCompare(right.id);
    })
    .slice(0, limit);
  const note = behavior.meta.sessionsTruncated
    ? `会话较多，只在 Token 最多的 ${behavior.meta.sessionLimit} 个会话里排序`
    : null;
  return { sessions, note };
}

/** 额度页按来源挑窗口、起窗口名；报告沿用调用方给的同一套规则，缺省时用来源自带的名字。 */
export interface ReportQuotaLabels {
  windows: (provider: QuotaProviderEnvelope) => readonly QuotaWindowSnapshot[];
  label: (window: QuotaWindowSnapshot, provider: QuotaProviderEnvelope) => string;
}

const DEFAULT_QUOTA_LABELS: ReportQuotaLabels = {
  windows: (provider) => provider.windows,
  label: (window) => window.windowLabel || window.windowId,
};

function quotaRows(providers: readonly QuotaProviderEnvelope[] | undefined, now: number, labels: ReportQuotaLabels): ReportQuota[] {
  return (providers || []).flatMap((provider) => {
    if (!validateQuotaProviderEnvelopeStructure(provider) || (provider.status !== 'ok' && provider.status !== 'stale')) return [];
    return labels.windows(provider).flatMap((window) => {
      const reading = readQuotaWindow(window, now);
      if (!reading) return [];
      return [{
        key: JSON.stringify([provider.providerId, provider.scope, window.windowId]),
        provider: providerDisplayName(provider),
        window: labels.label(window, provider),
        remaining: reading.remaining,
        level: quotaLevel(reading.remaining),
        stale: provider.status === 'stale' || reading.status === 'stale',
        resetsAt: reading.resetsAt ?? null,
      }];
    });
  }).sort((left, right) => left.remaining - right.remaining || left.key.localeCompare(right.key));
}

/** 与 `budget.rs::used_for` 同一套取数：缺少该行是 0，缺少账号维度或费用不可得是不可得。 */
export function budgetUsed(rule: BudgetRule, stats: StatsData): number | null {
  let row: { tokens: unknown; cost: unknown };
  if (rule.scopeKind === 'all') {
    row = { tokens: stats.summary.totalTokens, cost: stats.summary.totalCost };
  } else {
    const group = rule.scopeKind === 'tool' ? stats.tools : rule.scopeKind === 'model' ? stats.models : stats.providers;
    if (!group) return null;
    const found = group[rule.scopeId];
    if (!found) return 0;
    row = { tokens: found.total, cost: found.cost };
  }
  const value = rule.metric === 'tokens' ? row.tokens : row.cost;
  return finite(value) && value >= 0 ? value : null;
}

function budgetRows(rules: readonly BudgetRule[] | undefined, kind: ReportKind, stats: StatsData, scope: DataScope): ReportBudget[] {
  if (scope !== 'local') return [];
  return (rules || [])
    .filter((rule) => rule.enabled && rule.period === kind)
    .map((rule) => {
      const used = budgetUsed(rule, stats);
      const percent = used === null ? null : Math.round((used / rule.limit) * 1000) / 10;
      const level: BudgetLevel = used === null
        ? 'unavailable'
        : used >= rule.limit ? 'over' : used * 100 >= rule.limit * rule.warnPercent ? 'warn' : 'ok';
      return { id: rule.id, rule, used, percent, level };
    });
}

function formatCompactTokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

function buildHighlights(report: Omit<PeriodReport, 'highlights'>): string[] {
  const lines: string[] = [];
  const { totals, deltas, period } = report;
  if (totals.effectiveTokens === 0 && totals.requests === 0) return [`${period.shortLabel}没有用量记录`];
  const tokenDelta = describeDelta(deltas.tokens);
  if (deltas.tokens.kind === 'change' && Math.abs(deltas.tokens.percent) < 0.5) {
    lines.push(`有效 Token ${formatCompactTokens(totals.effectiveTokens)}，与${period.previousLabel}基本持平`);
  } else if (deltas.tokens.kind === 'change') {
    lines.push(`有效 Token ${formatCompactTokens(totals.effectiveTokens)}，比${period.previousLabel}${deltas.tokens.percent > 0 ? '多' : '少'} ${Math.abs(deltas.tokens.percent).toFixed(0)}%`);
  } else if (tokenDelta) {
    lines.push(`有效 Token ${formatCompactTokens(totals.effectiveTokens)}，${period.previousLabel}${deltas.tokens.kind === 'new' ? '没有记录' : '持平'}`);
  }
  const [lead] = report.agents;
  if (lead && lead.share !== null && lead.id !== '__other__') lines.push(`${lead.name} 用量最多，占 ${(lead.share * 100).toFixed(0)}%`);
  if (report.peakDay && report.days.length > 1) lines.push(`最忙的一天是 ${zhDay(report.peakDay.date)}，用了 ${formatCompactTokens(report.peakDay.tokens)}`);
  if (totals.cacheReuse !== null) {
    const points = deltas.cacheReusePoints;
    lines.push(`缓存复用率 ${(totals.cacheReuse * 100).toFixed(1)}%${points !== null && Math.abs(points) >= 0.1 ? `，${points > 0 ? '提高' : '降低'} ${Math.abs(points).toFixed(1)} 个百分点` : ''}`);
  }
  const over = report.budgets.filter((budget) => budget.level === 'over').length;
  if (over > 0) lines.push(`${over} 项预算超出上限`);
  else if (report.budgets.length > 0 && report.budgets.every((budget) => budget.level === 'ok')) lines.push('预算全部在上限以内');
  return lines;
}

export function buildPeriodReport(input: BuildPeriodReportInput): PeriodReport {
  const { period, scope, current, previous } = input;
  const now = input.now ?? new Date();
  const limit = input.breakdownLimit ?? 6;
  const totals = totalsFor(current, period.start, period.end);
  const previousTotals = previous ? totalsFor(previous, period.previousStart, period.previousEnd) : null;
  const days: ReportDay[] = [];
  for (let day = period.start; day <= period.end; day = addDays(day, 1)) {
    const tokens = current.heatmap?.[day];
    days.push({ date: day, tokens: finite(tokens) && tokens > 0 ? tokens : 0 });
  }
  const peakDay = days.reduce<ReportDay | null>((best, day) => (day.tokens > 0 && (!best || day.tokens > best.tokens) ? day : best), null);
  const { sessions, note } = topSessions(scope === 'local' ? input.behavior : null, input.sessionLimit ?? 5);
  const withoutHighlights: Omit<PeriodReport, 'highlights'> = {
    period,
    scope,
    generatedAt: now.toISOString(),
    totals,
    previous: previousTotals,
    deltas: {
      tokens: compareValues(totals.effectiveTokens, previousTotals?.effectiveTokens ?? null),
      cost: compareValues(totals.cost, previousTotals ? previousTotals.cost : null),
      requests: compareValues(totals.requests, previousTotals?.requests ?? null),
      cacheReusePoints: totals.cacheReuse !== null && previousTotals?.cacheReuse != null
        ? (totals.cacheReuse - previousTotals.cacheReuse) * 100
        : null,
    },
    days,
    peakDay,
    agents: breakdown(current.tools, previous?.tools, totals.effectiveTokens, toolDisplayName, limit),
    models: breakdown(current.models, previous?.models, totals.effectiveTokens, (id) => id, limit),
    accounts: current.providers && Object.keys(current.providers).length > 0
      ? breakdown(current.providers, previous?.providers ?? null, totals.effectiveTokens, (id) => id, limit)
      : null,
    sessions,
    sessionsNote: scope === 'local' ? note : '云端账本不含会话明细，最贵的会话只在本机账本里统计',
    quotas: quotaRows(input.quotaProviders, now.getTime(), input.quotaLabels ?? DEFAULT_QUOTA_LABELS),
    budgets: budgetRows(input.budgetRules, period.kind, current, scope),
  };
  return { ...withoutHighlights, highlights: buildHighlights(withoutHighlights) };
}

/** 文件名片段，例如 `weekly-2026-10-13_2026-10-19`。 */
export function reportFileSlug(period: ReportPeriod): string {
  return `${period.kind === 'week' ? 'weekly' : 'monthly'}-${period.start}_${period.end}`;
}

export function reportTitle(period: ReportPeriod): string {
  return `${period.kind === 'week' ? '用量周报' : '用量月报'} · ${period.label}`;
}
