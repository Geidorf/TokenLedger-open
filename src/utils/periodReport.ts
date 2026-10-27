import type { BehaviorAnalysisResponse, DataScope, QuotaProviderEnvelope, QuotaWindowSnapshot, StatsData, ToolStat } from '../types';
import { summaryEffectiveTokens } from '../types';
import type { BudgetRule, BudgetLevel } from '../hooks/useBudget';
import { summaryCacheReuse } from '../components/usage/usageSummary';
import { toolDisplayName } from './toolDisplayName';
import { validateQuotaProviderEnvelopeStructure } from './contracts/quota';
import { providerDisplayName, quotaLevel, readQuotaWindow, type QuotaLevel } from './quotaOverview';
import { t, type Lang } from '../i18n';

/**
 * 周报 / 月报：把一个已经结束（或进行中）的日历周、日历月和紧挨着的上一期并排汇总。
 *
 * 不新增任何口径：两期各读一次看板同一份 Stats v2（`range = 'custom'` 的本地日期闭区间），
 * 最贵的会话读「会话」页同一份行为分析，额度读额度页同一份快照，预算按设置页的规则在
 * 本期统计上复算（与 `src-tauri/src/budget.rs` 的 `used_for` 同一套取数）。
 * 本文件零 React 依赖，应用内视图、HTML/PDF 与图片导出共用它的结果。
 *
 * 文字（期次名、亮点、「其他 N 项」等）按传入的 `lang` 生成，缺省中文：导出固定中文，
 * 只有应用内视图按界面语言另建一份。
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

const EN_MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function dayLabel(day: string, lang: Lang, withYear = false): string {
  const [year, month, date] = day.split('-').map(Number);
  const monthText = lang === 'zh' ? month : EN_MONTHS_SHORT[month - 1];
  return t(withYear ? 'periodReport.date.dayYear' : 'periodReport.date.day', { year, month: monthText, day: date }, lang);
}

function yearMonthLabel(year: number, month: number, lang: Lang): string {
  return t('periodReport.month.yearMonth', { year, month: lang === 'zh' ? month : EN_MONTHS[month - 1] }, lang);
}

function spanLabel(start: string, end: string, today: string, lang: Lang): string {
  const withYear = start.slice(0, 4) !== today.slice(0, 4) || start.slice(0, 4) !== end.slice(0, 4);
  return start === end
    ? dayLabel(start, lang, withYear)
    : t('periodReport.date.span', { start: dayLabel(start, lang, withYear), end: dayLabel(end, lang, withYear) }, lang);
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
export function reportPeriod(kind: ReportKind, offset: number, today: string, lang: Lang = 'zh'): ReportPeriod {
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
    return year === Number(today.slice(0, 4))
      ? t('periodReport.month.name', { month: lang === 'zh' ? month : EN_MONTHS[month - 1] }, lang)
      : yearMonthLabel(year, month, lang);
  };
  const label = kind === 'month' ? yearMonthLabel(Number(start.slice(0, 4)), Number(start.slice(5, 7)), lang) : spanLabel(start, fullEnd, today, lang);
  const previousLabel = kind === 'month'
    ? (complete ? monthName(previousStart) : t('periodReport.month.sameDays', { month: monthName(previousStart) }, lang))
    : t(complete ? 'periodReport.week.previous' : 'periodReport.week.previousSame', undefined, lang);
  const relative: Record<ReportKind, string[]> = {
    week: [t('periodReport.week.current', undefined, lang), t('periodReport.week.last', undefined, lang), t('periodReport.week.twoAgo', undefined, lang)],
    month: [t('periodReport.month.current', undefined, lang), t('periodReport.month.last', undefined, lang)],
  };
  const shortLabel = relative[kind][-step] ?? (kind === 'week' ? t('periodReport.week.from', { date: dayLabel(start, lang) }, lang) : monthName(start));
  return { kind, start, end, complete, previousStart, previousEnd, label, previousLabel, shortLabel };
}

/** 报告页的期次选择：从进行中的一期往前数 `count` 期。 */
export function reportPeriodOptions(kind: ReportKind, today: string, count = kind === 'week' ? 8 : 6, lang: Lang = 'zh'): ReportPeriod[] {
  return Array.from({ length: count }, (_, index) => reportPeriod(kind, -index, today, lang));
}

/** 默认打开上一期完整的周报 / 月报——每周一自动生成的也是这一期。 */
export const DEFAULT_REPORT_OFFSET = -1;

export type ReportDelta =
  | { kind: 'change'; percent: number }
  | { kind: 'new' }
  | { kind: 'flat' }
  /** 云端上一期零记录零 Token：没有可信基线，不当成真零（GLB-01）。 */
  | { kind: 'missing' }
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

export function describeDelta(delta: ReportDelta, lang: Lang = 'zh'): string | null {
  if (delta.kind === 'new') return t('periodReport.delta.none', undefined, lang);
  if (delta.kind === 'flat') return t('periodReport.delta.flat', undefined, lang);
  if (delta.kind === 'missing') return t('periodReport.delta.baselineMissing', undefined, lang);
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
  /** 有效 Token；接口缺输入或输出时为 null（不可得），不按 0 算。 */
  tokens: number | null;
  requests: number;
  cost: number | null;
  /** 占本期有效 Token 的比例 0–1。 */
  share: number | null;
  delta: ReportDelta;
}

export interface ReportSession {
  id: string;
  /** 前端内部工具键，用于打开会话详情；不写入导出。 */
  toolId: string;
  /** 展示名，不用于反查会话。 */
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
  /** 报告里文字的语言；缺省中文（导出固定中文）。 */
  lang?: Lang;
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

function rowTokens(row: { input?: number; output?: number }): number | null {
  return finite(row.input) && row.input >= 0 && finite(row.output) && row.output >= 0 ? row.input + row.output : null;
}

function breakdown(
  current: Record<string, BreakdownSource> | undefined,
  previous: Record<string, BreakdownSource> | undefined | null,
  effectiveTotal: number,
  displayName: (id: string) => string,
  limit: number,
  lang: Lang,
): ReportBreakdownRow[] {
  const rows = Object.entries(current || {})
    .map(([id, row]) => {
      const tokens = rowTokens(row);
      const before = previous ? previous[id] : undefined;
      const beforeTokens = before ? rowTokens(before) : 0;
      return {
        id,
        name: displayName(row.name || id),
        tokens,
        requests: row.requests || 0,
        cost: knownCost(row.cost),
        share: tokens !== null && effectiveTotal > 0 ? tokens / effectiveTotal : null,
        delta: previous && tokens !== null && beforeTokens !== null ? compareValues(tokens, beforeTokens) : { kind: 'unavailable' } as ReportDelta,
      };
    })
    .filter((row) => row.tokens === null || row.tokens > 0 || row.requests > 0)
    // Token 不可得的行排在已知行之后，按记录数排，不当成 0 混进排名。
    .sort((left, right) => {
      if ((left.tokens === null) !== (right.tokens === null)) return left.tokens === null ? 1 : -1;
      return (right.tokens ?? 0) - (left.tokens ?? 0) || right.requests - left.requests || left.name.localeCompare(right.name);
    });
  if (rows.length <= limit) return rows;
  const head = rows.slice(0, limit - 1);
  const rest = rows.slice(limit - 1);
  const restTokens = rest.every((row) => row.tokens !== null) ? rest.reduce((sum, row) => sum + (row.tokens as number), 0) : null;
  const restCosts = rest.map((row) => row.cost);
  return [...head, {
    id: '__other__',
    name: t('periodReport.other', { count: rest.length }, lang),
    tokens: restTokens,
    requests: rest.reduce((sum, row) => sum + row.requests, 0),
    cost: restCosts.every((cost) => cost !== null) ? restCosts.reduce<number>((sum, cost) => sum + (cost as number), 0) : null,
    share: restTokens !== null && effectiveTotal > 0 ? restTokens / effectiveTotal : null,
    delta: { kind: 'unavailable' },
  }];
}

function topSessions(behavior: BehaviorAnalysisResponse | null | undefined, limit: number, lang: Lang): { sessions: ReportSession[] | null; note: string | null } {
  if (!behavior) return { sessions: null, note: null };
  const sessions = [...behavior.sessions]
    .map((session) => ({
      id: session.id,
      toolId: session.tool,
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
      return right.tokens - left.tokens || left.id.localeCompare(right.id) || left.toolId.localeCompare(right.toolId);
    })
    .slice(0, limit);
  const note = behavior.meta.sessionsTruncated
    ? t('periodReport.sessions.truncated', { limit: behavior.meta.sessionLimit }, lang)
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
/** 预算达成一句话：只有每条都可核对且未超出时才说「全部在上限内」。 */
export function budgetSummary(budgets: readonly ReportBudget[], lang: Lang = 'zh'): string {
  if (budgets.some((budget) => budget.level === 'over')) return t('periodReport.budgetSummary.over', undefined, lang);
  const unknown = budgets.filter((budget) => budget.level === 'unavailable').length;
  if (unknown > 0) return t('periodReport.budgetSummary.unavailable', { count: unknown }, lang);
  if (budgets.some((budget) => budget.level === 'warn')) return t('periodReport.budgetSummary.warn', undefined, lang);
  return t('periodReport.budgetSummary.all', undefined, lang);
}

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

function buildHighlights(report: Omit<PeriodReport, 'highlights'>, lang: Lang): string[] {
  const lines: string[] = [];
  const { totals, deltas, period } = report;
  const say = (key: Parameters<typeof t>[0], vars?: Record<string, string | number>) => t(key, vars, lang);
  if (totals.effectiveTokens === 0 && totals.requests === 0) return [say('periodReport.highlights.empty', { period: period.shortLabel })];
  const tokenDelta = describeDelta(deltas.tokens, lang);
  const tokens = formatCompactTokens(totals.effectiveTokens);
  if (deltas.tokens.kind === 'change' && Math.abs(deltas.tokens.percent) < 0.5) {
    lines.push(say('periodReport.highlights.tokensFlat', { tokens, period: period.previousLabel }));
  } else if (deltas.tokens.kind === 'change') {
    lines.push(say('periodReport.highlights.tokensChange', {
      tokens,
      period: period.previousLabel,
      direction: say(deltas.tokens.percent > 0 ? 'periodReport.highlights.tokensMore' : 'periodReport.highlights.tokensLess'),
      percent: Math.abs(deltas.tokens.percent).toFixed(0),
    }));
  } else if (deltas.tokens.kind === 'missing') {
    lines.push(say('periodReport.highlights.baselineMissing', { tokens, period: period.previousLabel }));
  } else if (tokenDelta) {
    lines.push(say(deltas.tokens.kind === 'new' ? 'periodReport.highlights.tokensNew' : 'periodReport.highlights.tokensFlatShort', { tokens, period: period.previousLabel }));
  }
  const [lead] = report.agents;
  // 有 Agent 的 Token 不可得时说不准谁最多，不写这句。
  if (lead && lead.share !== null && lead.id !== '__other__' && report.agents.every((row) => row.tokens !== null)) {
    lines.push(say('periodReport.highlights.leadAgent', { agent: lead.name, percent: (lead.share * 100).toFixed(0) }));
  }
  if (report.peakDay && report.days.length > 1) {
    lines.push(say('periodReport.highlights.peakDay', { date: dayLabel(report.peakDay.date, lang), tokens: formatCompactTokens(report.peakDay.tokens) }));
  }
  if (totals.cacheReuse !== null) {
    const points = deltas.cacheReusePoints;
    const base = say('periodReport.highlights.cacheReuse', { percent: (totals.cacheReuse * 100).toFixed(1) });
    lines.push(points !== null && Math.abs(points) >= 0.1
      ? say('periodReport.highlights.cacheChange', {
        base,
        direction: say(points > 0 ? 'periodReport.highlights.cacheUp' : 'periodReport.highlights.cacheDown'),
        points: Math.abs(points).toFixed(1),
      })
      : base);
  }
  const over = report.budgets.filter((budget) => budget.level === 'over').length;
  if (over > 0) lines.push(say('periodReport.highlights.budgetsOver', { count: over }));
  else if (report.budgets.length > 0 && report.budgets.every((budget) => budget.level === 'ok')) lines.push(say('periodReport.highlights.budgetsOk'));
  return lines;
}

export function buildPeriodReport(input: BuildPeriodReportInput): PeriodReport {
  const { period, scope, current, previous } = input;
  const now = input.now ?? new Date();
  const lang = input.lang ?? 'zh';
  const limit = input.breakdownLimit ?? 6;
  const totals = totalsFor(current, period.start, period.end);
  // 与看板、简报同一条件：云端上一期零记录零 Token 不能证明「真的没有用量」。
  const baselineMissing = scope === 'cloud' && !!previous
    && previous.summary.totalRequests === 0 && previous.summary.totalTokens === 0;
  const baseline = baselineMissing ? null : previous;
  const previousTotals = baseline ? totalsFor(baseline, period.previousStart, period.previousEnd) : null;
  const compare = (current: number | null, before: number | null): ReportDelta => (
    baselineMissing ? { kind: 'missing' } : compareValues(current, before)
  );
  const days: ReportDay[] = [];
  for (let day = period.start; day <= period.end; day = addDays(day, 1)) {
    const tokens = current.heatmap?.[day];
    days.push({ date: day, tokens: finite(tokens) && tokens > 0 ? tokens : 0 });
  }
  const peakDay = days.reduce<ReportDay | null>((best, day) => (day.tokens > 0 && (!best || day.tokens > best.tokens) ? day : best), null);
  const { sessions, note } = topSessions(scope === 'local' ? input.behavior : null, input.sessionLimit ?? 5, lang);
  const withoutHighlights: Omit<PeriodReport, 'highlights'> = {
    period,
    scope,
    generatedAt: now.toISOString(),
    totals,
    previous: previousTotals,
    deltas: {
      tokens: compare(totals.effectiveTokens, previousTotals?.effectiveTokens ?? null),
      cost: compare(totals.cost, previousTotals ? previousTotals.cost : null),
      requests: compare(totals.requests, previousTotals?.requests ?? null),
      cacheReusePoints: totals.cacheReuse !== null && previousTotals?.cacheReuse != null
        ? (totals.cacheReuse - previousTotals.cacheReuse) * 100
        : null,
    },
    days,
    peakDay,
    agents: breakdown(current.tools, baseline?.tools, totals.effectiveTokens, toolDisplayName, limit, lang),
    models: breakdown(current.models, baseline?.models, totals.effectiveTokens, (id) => id, limit, lang),
    accounts: current.providers && Object.keys(current.providers).length > 0
      ? breakdown(current.providers, baseline?.providers ?? null, totals.effectiveTokens, (id) => id, limit, lang)
      : null,
    sessions,
    sessionsNote: scope === 'local' ? note : t('periodReport.sessions.cloudNote', undefined, lang),
    quotas: quotaRows(input.quotaProviders, now.getTime(), input.quotaLabels ?? DEFAULT_QUOTA_LABELS),
    budgets: budgetRows(input.budgetRules, period.kind, current, scope),
  };
  return { ...withoutHighlights, highlights: buildHighlights(withoutHighlights, lang) };
}

/** 文件名片段，例如 `weekly-2026-10-13_2026-10-19`。 */
export function reportFileSlug(period: ReportPeriod): string {
  return `${period.kind === 'week' ? 'weekly' : 'monthly'}-${period.start}_${period.end}`;
}

export function reportTitle(period: ReportPeriod, lang: Lang = 'zh'): string {
  return `${t(period.kind === 'week' ? 'periodReport.title.week' : 'periodReport.title.month', undefined, lang)} · ${period.label}`;
}
