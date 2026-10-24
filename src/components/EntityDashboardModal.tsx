import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertCircle, Check, ChevronLeft, ChevronRight, Clock3, Copy, DollarSign, Layers3, LoaderCircle, Monitor, PieChart, TableProperties, X } from 'lucide-react';
import type { CompositionItem, CustomDateRange, DataScope, EntityDashboard, RangeKey, StatsQueryContext } from '../types';
import { formatEstimatedUsd, formatNum, formatTokens } from '../utils/format';
import { rangeDisplayName } from '../utils/rangeDisplay';
import { detailGranularityLabel } from '../utils/detailGranularity';
import { MetricsGrid } from './MetricsGrid';
import { TrendPanel } from './TrendPanel';
import { YearHeatmap } from './YearHeatmap';
import { focusWrapTarget } from '../utils/frontendContracts';
import { toolDisplayName } from '../utils/toolDisplayName';
import { computeUnitCostUsd, formatUnitCost, unitCostLabel } from '../utils/unitCost';
import { useSegmentedIndicator } from '../hooks/useSegmentedIndicator';
import { getLang, t, useLang } from '../i18n';

interface EntitySelection {
  kind: 'tool' | 'model';
  name: string;
  tool?: string;
}

interface EntityDashboardModalProps {
  selection: EntitySelection;
  range: RangeKey;
  customRange?: CustomDateRange | null;
  scope: DataScope;
  data: EntityDashboard | null;
  loading: boolean;
  error: string;
  onClose: () => void;
  onRetry: () => void;
  onOpenDetails: (machine?: string) => void;
  onOpenEntity: (kind: 'tool' | 'model', name: string, tool?: string) => void;
  /**
   * Q10：与实体查询同一 range/scope、同一筛选下的全局统计，用于「占总预估
   * 费用」的分母。省略、scope 不一致、canonical 查询有任何字段不同，或两侧
   * `generatedAt` 不在同一自然日/相差超过阈值（见 `sameFreshnessWindow`），
   * 占比整项隐藏——绝不用不同源或不同新鲜度的两个总数拼出可能误导的百分比。
   *
   * 复核修复 R2-2 更正：上一版这里写「`EntityDashboard` 契约没有暴露实体查询
   * 自身的新鲜度字段」，独立复核指出这不成立——本地看板直接复用统计 meta
   * （`mod.rs:6185-6190`）、云端实体 RPC（迁移
   * `20260715001948_…multi_filter_search.sql:757/918`）都会写 `generatedAt`，
   * 类型见 `types.ts:251-257`。真正的问题是 `stale`：生产环境恒为 `false`
   * （Rust 只写 `false`；缓存命中原样返回旧快照；云端迁移里的 `'stale', true`
   * 是刷新函数的返回值，不是统计 meta），单靠 `!stale` 从未真正拦下过缓存
   * 快照或跨午夜的场景。现在两侧的 `generatedAt` 都会传入并逐一比较，`stale`
   * 保留作为不会生效但也无害的防御性冗余。
   */
  globalCostContext?: {
    totalCost: number | null;
    query: StatsQueryContext | null;
    scope: DataScope;
    stale?: boolean;
    generatedAt?: string | null;
  } | null;
}

/** 分布卡片的对比口径：有效 Token 或预估费用，条形、排序与首位数字一起切换（T10.111）。 */
export type CompositionMetric = 'tokens' | 'cost';

function readableCost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 预估费用（T10.154 D41）：未知写「不可得」；最近明细是单条记录，用记录精度。 */
function describeCost(value: unknown, kind: 'summary' | 'record' = 'summary'): string {
  return formatEstimatedUsd(readableCost(value), kind);
}

export function describeCompositionItem(item: CompositionItem, metric: CompositionMetric, total: number): string {
  const measure = metric === 'cost' ? readableCost(item.cost) : item.tokens;
  const share = measure !== null && total > 0 ? t('entity.share', { pct: Math.round((measure / total) * 100) }) : '';
  return metric === 'cost'
    ? `${describeCost(item.cost)}${share} · ${formatTokens(item.tokens)} · ${t('entity.requests', { n: formatNum(item.requests) })}`
    : `${formatTokens(item.tokens)}${share} · ${t('entity.requests', { n: formatNum(item.requests) })} · ${describeCost(item.cost)}`;
}

function visibleEntityName(kind: 'tool' | 'model', name: string): string {
  return kind === 'tool' ? toolDisplayName(name) : name;
}

function CompositionList({ title, icon: Icon, items, metric, onSelect, labelFor = (value: string) => value }: { title: string; icon: typeof Layers3; items: CompositionItem[]; metric: CompositionMetric; onSelect?: (item: CompositionItem) => void; labelFor?: (value: string) => string }) {
  const measure = (item: CompositionItem) => (metric === 'cost' ? readableCost(item.cost) ?? 0 : item.tokens);
  const sorted = [...items].sort((left, right) => metric === 'cost'
    ? (readableCost(right.cost) ?? -1) - (readableCost(left.cost) ?? -1)
    : measure(right) - measure(left));
  const total = sorted.reduce((sum, item) => sum + measure(item), 0);
  const max = Math.max(metric === 'cost' ? 0.01 : 1, ...sorted.map(measure));
  return (
    <section className="entity-composition-card" data-metric={metric}>
      <div className="entity-section-title">
        <Icon className="h-4 w-4" />
        {title}
      </div>
      {metric === 'cost' && items.some((item) => readableCost(item.cost) === null) && (
        <p className="entity-empty-copy">{t('entity.unknownCostNote')}</p>
      )}
      {items.length === 0 ? (
        <p className="entity-empty-copy">{t('entity.noComposition')}</p>
      ) : (
        <div className="entity-composition-list">
          {sorted.slice(0, 8).map((item) => (
            onSelect ? (
            <button className="entity-composition-row entity-composition-button" type="button" key={item.value} onClick={() => onSelect(item)}>
              <div>
                <strong className="entity-composition-value" title={item.value}>{labelFor(item.value)}</strong>
                <span>{describeCompositionItem(item, metric, total)}</span>
              </div>
              <div className="entity-composition-bar" aria-hidden="true">
                <span style={{ width: `${Math.max(0, measure(item) / max * 100)}%` }} />
              </div>
            </button>
            ) : (
              <div className="entity-composition-row" key={item.value}>
                <div>
                  <strong className="entity-composition-value" title={item.value}>{labelFor(item.value)}</strong>
                  <span>{describeCompositionItem(item, metric, total)}</span>
                </div>
                <div className="entity-composition-bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(0, measure(item) / max * 100)}%` }} />
                </div>
              </div>
            )
          ))}
        </div>
      )}
    </section>
  );
}

function formatDateTime(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(getLang() === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function sameStringSet(a: string[] = [], b: string[] = []): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

/**
 * Q10：占比的分母必须来自与实体查询逐字段相同的 canonical 查询，否则两个
 * 不同口径的总数拼出的百分比只会误导用户。复核修复 P2-2：改成双向逐字段相等
 * （range、自定义起止、时区、machines/tools/models/search 全部一致），而不是
 * 只检查“实体一侧没有被额外收窄”——原判定是单向的，如果将来全局统计反而被
 * 收窄，分子分母会变得同样不可比，但旧代码不会拦下来。任意一侧缺失或任一
 * 字段不同，调用方一律隐藏整项，绝不回退成 0 或用“不可得”掩饰“其实不可
 * 比较”的事实。
 */
function sameCostQueryScope(
  entityQuery: StatsQueryContext | null | undefined,
  globalQuery: StatsQueryContext | null | undefined,
): boolean {
  if (!entityQuery || !globalQuery) return false;
  if (entityQuery.range !== globalQuery.range) return false;
  if (entityQuery.range === 'custom' && (entityQuery.start !== globalQuery.start || entityQuery.end !== globalQuery.end)) return false;
  if (entityQuery.timezone !== globalQuery.timezone) return false;
  if (!sameStringSet(entityQuery.machines, globalQuery.machines)) return false;
  if (!sameStringSet(entityQuery.tools, globalQuery.tools)) return false;
  if (!sameStringSet(entityQuery.models, globalQuery.models)) return false;
  if ((entityQuery.search?.trim() || '') !== (globalQuery.search?.trim() || '')) return false;
  return true;
}

const GENERATED_AT_FRESHNESS_MS = 5 * 60 * 1000;

/**
 * 复核修复 R2-2：把 ISO 时间戳换算成给定时区下的公历日期（YYYY-MM-DD）。
 * 目的是发现"entity 和全局两次抓取相隔没多久，但恰好跨过了 today 范围的
 * 午夜边界"这类场景——单看时间差可能小于阈值，但两侧其实已经落在不同自然
 * 日，分子分母依然不可比。
 */
function civilDateInZone(iso: string, timezone: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(ms);
    const part = (type: string) => parts.find((item) => item.type === type)?.value;
    const year = part('year');
    const month = part('month');
    const day = part('day');
    return year && month && day ? `${year}-${month}-${day}` : null;
  } catch {
    return null;
  }
}

/**
 * 复核修复 R2-2：`globalCostContext.stale` 在生产环境恒为 `false`——Rust 只写
 * `false`（`mod.rs:5021`），缓存命中原样返回旧快照里同样是 `false` 的值
 * （`cache.rs`，5 分钟 TTL），云端迁移里的 `'stale', true` 是刷新函数的返回
 * 值、不是统计 meta；因此单靠 `!stale` 从未真正拦下过缓存快照。真正能判断
 * 新鲜度的是 `generatedAt`：entity 看板与全局统计各自独立抓取，只要一侧
 * 缺失、两者相差超过阈值，或在查询时区下已经不是同一个自然日，就说明分子
 * 分母可能来自不同快照——宁可隐藏也不拼一个看似精确、实则可能对不上的
 * 百分比。阈值取 5 分钟，对齐后端统计缓存的 TTL（`cache.rs`）。
 */
function sameFreshnessWindow(
  entityGeneratedAt: string | null | undefined,
  globalGeneratedAt: string | null | undefined,
  timezone: string | undefined,
): boolean {
  if (!entityGeneratedAt || !globalGeneratedAt || !timezone) return false;
  const entityMs = Date.parse(entityGeneratedAt);
  const globalMs = Date.parse(globalGeneratedAt);
  if (!Number.isFinite(entityMs) || !Number.isFinite(globalMs)) return false;
  if (Math.abs(entityMs - globalMs) > GENERATED_AT_FRESHNESS_MS) return false;
  const entityDay = civilDateInZone(entityGeneratedAt, timezone);
  const globalDay = civilDateInZone(globalGeneratedAt, timezone);
  return entityDay !== null && entityDay === globalDay;
}

export function EntityDashboardModal({
  selection,
  range,
  customRange = null,
  scope,
  data,
  loading,
  error,
  onClose,
  onRetry,
  onOpenDetails,
  onOpenEntity,
  globalCostContext = null,
}: EntityDashboardModalProps) {
  const lang = useLang();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const [modelCopyState, setModelCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const [history, setHistory] = useState<EntitySelection[]>([]);
  const copyResetRef = useRef<number | null>(null);
  const titleId = `entity-dashboard-${selection.kind}-title`;
  const contextLabel = selection.kind === 'tool' ? t('entity.context.tool') : t('entity.context.model');

  const handleNavigate = (kind: 'tool' | 'model', name: string, tool?: string) => {
    setHistory((prev) => [...prev, selection]);
    onOpenEntity(kind, name, tool);
  };

  const handleBack = () => {
    if (history.length === 0) return;
    const previous = history[history.length - 1];
    setHistory((prev) => prev.slice(0, -1));
    onOpenEntity(previous.kind, previous.name, previous.tool);
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index >= history.length) return;
    const target = history[index];
    setHistory((prev) => prev.slice(0, index));
    onOpenEntity(target.kind, target.name, target.tool);
  };

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    setModelCopyState('idle');
    if (copyResetRef.current !== null) {
      window.clearTimeout(copyResetRef.current);
      copyResetRef.current = null;
    }
  }, [selection.kind, selection.name]);

  useEffect(() => () => {
    if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
  }, []);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = closeRef.current?.closest('[role="dialog"]');
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute('hidden'));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const wrapTarget = focusWrapTarget(
        event.shiftKey ? 'backward' : 'forward',
        document.activeElement === first,
        document.activeElement === last,
      );
      if (wrapTarget === 'last') {
        event.preventDefault();
        last.focus();
      } else if (wrapTarget === 'first') {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // The opener can be gone by now: a behaviour ranking row whose drill-down
      // changed the range is rebuilt with the list (T10.164 review N2). Focus
      // then goes to the main region instead of falling back to <body>.
      if (previous && !previous.isConnected) document.getElementById('main-content')?.focus({ preventScroll: true });
      else previous?.focus();
    };
  }, [selection.kind, selection.name, selection.tool]);

  const [compositionMetric, setCompositionMetric] = useState<CompositionMetric>('tokens');
  const compositionToggleRef = useSegmentedIndicator<HTMLDivElement>();
  const recent = data?.historyPage?.items || [];
  const granularityLabel = detailGranularityLabel(data?.historyPage);
  const rangeLabel = range === 'custom' ? rangeDisplayName('custom', customRange) : t(range === 'today' ? 'range.today' : range === 'week' ? 'range.week' : range === 'month' ? 'range.month' : range === 'year' ? 'range.year' : 'entity.rangeAll');
  const peakCopy = useMemo(() => {
    if (!data?.peak?.bucket) return t('entity.noPeak');
    return `${data.peak.bucket} · ${formatTokens(data.peak.tokens || 0)}`;
    // 文案随界面语言变化，lang 只用来触发重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, lang]);
  const entityTrend = useMemo(
    () => Object.entries(data?.heatmap || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, tokens]) => ({ date, [selection.name]: tokens })),
    [data?.heatmap, selection.name],
  );

  // Q10：占总预估费用 x% 与单位费用。分母必须和实体查询同一 range/scope/
  // 设备筛选、且两侧抓取时间足够新鲜（见 sameFreshnessWindow），否则宁可隐藏
  // 也不给误导性的百分比；单位费用只依赖实体自身的数据，永远可以尝试计算，
  // 算不出时显示t('entity.na')。
  const entityTotalCost = readableCost(data?.summary?.totalCost);
  const globalTotalCost = globalCostContext ? readableCost(globalCostContext.totalCost) : null;
  const shareComparable = Boolean(
    data
    && globalCostContext
    && !globalCostContext.stale
    && globalCostContext.scope === scope
    && sameCostQueryScope(data.meta?.query, globalCostContext.query)
    && sameFreshnessWindow(data.meta?.generatedAt, globalCostContext.generatedAt, data.meta?.query?.timezone),
  );
  // 复核修复 P2-2：分子大于分母只可能来自口径没对齐（例如缓存快照之间的时间差），
  // 就算前面的 sameCostQueryScope 已经通过，也不展示会误导人的 ">100%"，直接按
  // 不可得处理；真实的小额占比（0%〈实际值〈1%）用 "<1%" 而不是四舍五入抹成
  // "0%"，避免看起来像完全没有消耗。
  const rawSharePercent = shareComparable && globalTotalCost !== null && globalTotalCost > 0 && entityTotalCost !== null
    ? (entityTotalCost / globalTotalCost) * 100
    : null;
  const costSharePercent = rawSharePercent !== null && rawSharePercent <= 100 ? rawSharePercent : null;
  const costShareDisplay = costSharePercent === null
    ? t('entity.na')
    : costSharePercent > 0 && costSharePercent < 1
      ? '<1%'
      : `${Math.round(costSharePercent)}%`;
  // 复核修复 P3-3：输入或输出 Token 本身不可得时，不能用 `|| 0` 把缺口悄悄补成
  // 0——那会用「一半真实数据」算出一个看似正常、实则错误的单位费用。只要有一侧
  // 非有限，整个有效 Token 数就是不可得（NaN），computeUnitCostUsd 会据此返回
  // null 显示「不可得」，而不是一个基于部分数据的误导性数字。
  const entityEffectiveTokens = data && Number.isFinite(data.summary.inputTokens) && Number.isFinite(data.summary.outputTokens)
    ? data.summary.inputTokens + data.summary.outputTokens
    : Number.NaN;
  const unitCostUsd = computeUnitCostUsd(entityTotalCost, entityEffectiveTokens);
  // 复核修复 P3-4：极小的单位费用四舍五入到 $0.00 会看起来像“免费”，用 "<$0.01"
  // 如实表达“有成本但低于可显示精度”，而不是 0。
  const unitCostDisplay = formatUnitCost(unitCostUsd);
  // R2-1（root 2026-09-24 定夺，T10.159 集成时接线）：data.comparison 存在时，同一弹窗里 TrendPanel
  // 已渲染对齐窗口的「单位费用」格（TrendPanel 的 unitCostCell），洞察条只在没有 comparison 时显示本格；
  // 两处的计算、显示保护与标签都来自 utils/unitCost，不再各写一份。
  const showUnitCostCell = !data?.comparison;

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="modal-content entity-dashboard-modal tl-scrollbar"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={loading}
      >
        <header className={`modal-header entity-modal-header${modelCopyState === 'failed' ? ' has-copy-fallback' : ''}`}>
          {history.length > 0 && (
            <nav className="entity-breadcrumb-nav" aria-label={t('entity.historyNav')}>
              <button
                type="button"
                className="entity-back-button secondary-inline"
                onClick={handleBack}
                aria-label={t('entity.backAria')}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                <span>{t('entity.back')}</span>
              </button>
              <ol className="entity-breadcrumb-list">
                {history.map((item, idx) => (
                  <li key={`${item.kind}-${item.name}-${idx}`} className="entity-breadcrumb-item">
                    <button
                      type="button"
                      className="entity-breadcrumb-link"
                      onClick={() => handleBreadcrumbClick(idx)}
                      aria-label={t('entity.backTo', { name: visibleEntityName(item.kind, item.name) })}
                      title={t('entity.backTo', { name: visibleEntityName(item.kind, item.name) })}
                    >
                      {visibleEntityName(item.kind, item.name)}
                    </button>
                    <ChevronRight className="h-3 w-3 entity-breadcrumb-separator" aria-hidden="true" />
                  </li>
                ))}
                <li className="entity-breadcrumb-item is-current" aria-current="page">
                  <span>{visibleEntityName(selection.kind, selection.name)}</span>
                </li>
              </ol>
            </nav>
          )}
          <div className="entity-modal-heading">
            <span className="entity-kind-icon">{selection.kind === 'tool' ? <Layers3 className="h-5 w-5" /> : <Activity className="h-5 w-5" />}</span>
            <div>
              <div className="entity-heading-line">
                <h2 id={titleId} title={selection.name}>{visibleEntityName(selection.kind, selection.name)}</h2>
                <span>{contextLabel}</span>
              </div>
              <p>
                {t('entity.period', { range: rangeLabel, tool: selection.tool && selection.kind === 'model' ? `${toolDisplayName(selection.tool)} / ` : '', granularity: granularityLabel })}
              </p>
            </div>
          </div>
          <div className="entity-modal-actions">
            {selection.kind === 'model' && (
              <button
                className={`ghost-inline entity-copy-action${modelCopyState === 'failed' ? ' is-failed' : ''}${modelCopyState === 'copied' ? ' is-success' : ''}`}
                type="button"
                aria-label={modelCopyState === 'copying' ? t('entity.copy.copyingAria') : modelCopyState === 'failed' ? t('entity.copy.failedAria') : modelCopyState === 'copied' ? t('entity.copy.copiedAria') : t('entity.copy.action')}
                title={modelCopyState === 'copying' ? t('entity.copy.copyingAria') : modelCopyState === 'failed' ? t('entity.copy.failedTitle') : selection.name}
                disabled={modelCopyState === 'copying'}
                aria-busy={modelCopyState === 'copying' || undefined}
                onClick={async () => {
                  if (modelCopyState === 'copying') return;
                  setModelCopyState('copying');
                  try {
                    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
                    if (!clipboard?.writeText) throw new Error('clipboard unavailable');
                    await clipboard.writeText(selection.name);
                    setModelCopyState('copied');
                    if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
                    copyResetRef.current = window.setTimeout(() => {
                      setModelCopyState('idle');
                      copyResetRef.current = null;
                    }, 1600);
                  } catch {
                    if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
                    copyResetRef.current = null;
                    setModelCopyState('failed');
                  }
                }}
              >
                {modelCopyState === 'copying'
                  ? <LoaderCircle className="h-4 w-4 animate-spin" />
                  : modelCopyState === 'copied'
                    ? <Check className="h-4 w-4" />
                    : modelCopyState === 'failed'
                      ? <AlertCircle className="h-4 w-4" />
                      : <Copy className="h-4 w-4" />}
                {modelCopyState === 'copying' ? t('entity.copy.copying') : modelCopyState === 'copied' ? t('entity.copy.copied') : modelCopyState === 'failed' ? t('entity.copy.failed') : t('entity.copy.action')}
              </button>
            )}
            <button className="secondary-inline" type="button" onClick={() => onOpenDetails()}>
              <TableProperties className="h-4 w-4" />
              {t('entity.openDetails')}
            </button>
            <button ref={closeRef} className="modal-close" type="button" onClick={onClose} aria-label={t('entity.close')}>
              <X className="h-5 w-5" />
            </button>
          </div>
          {selection.kind === 'model' && modelCopyState === 'failed' && (
            <div className="entity-copy-fallback" role="status" aria-live="polite">
              <div>
                <strong>{t('entity.clipboard.title')}</strong>
                <span>{t('entity.clipboard.body')}</span>
              </div>
              <input
                type="text"
                readOnly
                value={selection.name}
                aria-label={t('entity.manualCopyAria')}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
              />
            </div>
          )}
        </header>

        {loading && !data ? (
          <div className="entity-loading-state">
            <LoaderCircle className="h-6 w-6 animate-spin" />
            <strong>{t('entity.loading.title')}</strong>
            <span>{t('entity.loading.body')}</span>
          </div>
        ) : error ? (
          <div className="details-state details-state-error" role="alert">
            <strong>{t('entity.error.title')}</strong>
            <span>{error}</span>
            <button
              className="secondary-inline"
              type="button"
              onClick={onRetry}
              disabled={loading}
              aria-busy={loading}
              title={loading ? t('entity.reloadingTitle') : t('entity.reloadTitle')}
            >
              <LoaderCircle className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              {loading ? t('entity.reloading') : t('entity.reload')}
            </button>
          </div>
        ) : data ? (
          <>
            <MetricsGrid summary={data.summary} showTotalTokens={false} comparison={data.comparison} meta={data.meta} range={range} scope={scope} />

            <div className="entity-insight-strip">
              <div>
                <Clock3 className="h-4 w-4" />
                <span>{t('entity.peak')}</span>
                <strong>{peakCopy}</strong>
              </div>
              <div>
                <Activity className="h-4 w-4" />
                <span>{t('entity.activeDays')}</span>
                <strong>{t('entity.days', { n: formatNum(data.activity?.activeDays || 0) })}</strong>
              </div>
              <div>
                <Clock3 className="h-4 w-4" />
                <span>{t('entity.firstSeen')}</span>
                <strong>{formatDateTime(data.activity?.firstSeenAt)}</strong>
              </div>
              <div>
                <Clock3 className="h-4 w-4" />
                <span>{t('entity.lastSeen')}</span>
                <strong>{formatDateTime(data.activity?.lastSeenAt)}</strong>
              </div>
              {shareComparable && (
                <div>
                  <PieChart className="h-4 w-4" />
                  <span>{t('entity.costShare')}</span>
                  <strong>{costShareDisplay}</strong>
                </div>
              )}
              {showUnitCostCell && (
                <div>
                  <DollarSign className="h-4 w-4" />
                  <span>{unitCostLabel()}</span>
                  <strong>{unitCostDisplay}</strong>
                </div>
              )}
            </div>

            {range === 'all' && !data.comparison ? (
              <section className="panel entity-trend-unavailable" aria-label={t('entity.trendUnavailableAria')}>
                <div className="entity-section-title">
                  <Activity className="h-4 w-4" />
                  {t('entity.trendUnavailable')}
                </div>
                <p>{t('entity.trendUnavailableBody')}</p>
              </section>
            ) : (
              <TrendPanel
                trends={entityTrend}
                activeTools={[]}
                comparison={data.comparison}
                range={range}
                scope={scope}
                currentSeriesName={selection.name}
                currentSeriesIsTool={selection.kind === 'tool'}
                currentOnlyNote={range === 'year'
                  ? t('entity.yearNote')
                  : undefined}
              />
            )}

            <section className="panel heatmap-panel entity-heatmap-panel">
              <div className="panel-title">
                <Activity className="h-4 w-4 text-primary" />
                {t('entity.yearHeatmap')}
              </div>
              <YearHeatmap heatmap={data.heatmap || {}} />
            </section>

            <div className="entity-composition-toolbar">
              <span>{t('entity.metricLabel')}</span>
              <div className="entity-metric-toggle tl-seg" role="group" aria-label={t('entity.metricLabel')} ref={compositionToggleRef}>
                <button type="button" aria-pressed={compositionMetric === 'tokens'} onClick={() => setCompositionMetric('tokens')}>{t('entity.metric.tokens')}</button>
                <button type="button" aria-pressed={compositionMetric === 'cost'} onClick={() => setCompositionMetric('cost')}>{t('entity.metric.cost')}</button>
              </div>
            </div>
            <div className="entity-composition-grid">
              {selection.kind === 'model' && (
                <CompositionList
                  title={t('entity.byTool')}
                  icon={Layers3}
                  items={data.composition.tools || []}
                  metric={compositionMetric}
                  labelFor={toolDisplayName}
                  onSelect={(item) => handleNavigate('model', selection.name, item.value)}
                />
              )}
              {selection.kind === 'tool' && (
                <CompositionList
                  title={t('entity.byModel')}
                  icon={Activity}
                  items={data.composition.models || []}
                  metric={compositionMetric}
                  onSelect={(item) => handleNavigate('model', item.value, selection.name)}
                />
              )}
              <CompositionList
                title={t('entity.byDevice')}
                icon={Monitor}
                items={data.composition.machines || []}
                metric={compositionMetric}
                onSelect={(item) => onOpenDetails(item.value)}
              />
            </div>

            <section className="panel entity-recent-panel">
              <div className="entity-recent-head">
                <div className="panel-title">
                  <TableProperties className="h-4 w-4 text-primary" />
                  {t('entity.recent')}
                </div>
                <span>{granularityLabel}</span>
              </div>
              {recent.length === 0 ? (
                <p className="entity-empty-copy">{t('entity.noRecent')}</p>
              ) : (
                <div className="entity-recent-list">
                  {recent.slice(0, 6).map((item) => (
                    <div key={`${item.id}-${item.timestamp}`}>
                      <div>
                        <strong className="entity-recent-model" title={item.model}>{item.model}</strong>
                        <span>{toolDisplayName(item.tool)} · {item.machineId || 'localhost'}</span>
                      </div>
                      <div>
                        <strong>{formatTokens(item.inputTokens + item.outputTokens)}</strong>
                        <span>{describeCost(item.cost, 'record')} · {formatDateTime(item.timestamp)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default EntityDashboardModal;
