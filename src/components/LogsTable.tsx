import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { CalendarDays, Check, ChevronDown, ChevronRight, Copy, Download, Filter, FolderSearch, History, LoaderCircle, Monitor, RefreshCw, RotateCcw, Search, Undo2, X } from 'lucide-react';
import { EmptyState } from './EmptyState';
import type { DayDrillCopy } from '../hooks/useDayDrill';
import type { CustomDateRange, DataScope, LogHistoryItem, RangeKey, UsageDetailsResponse } from '../types';
import { colorForTool, isEstimatedLogItem, toolColorMap } from '../types';
import { CACHE_METRIC_LABEL_KEY, cacheDetailMetrics, resolveCacheBreakdown } from '../utils/cacheDisplay';
import { detailGranularityLabel, rowGranularityLabel } from '../utils/detailGranularity';
import { formatEstimatedUsd, formatNum, formatTokens } from '../utils/format';
import { cacheHitRate, outputTokensPerSecond } from '../utils/usageSplit';
import { rangeDisplayName } from '../utils/rangeDisplay';
import { useTheme } from '../utils/useTheme';
import { FilterMultiSelect } from './FilterMultiSelect';
import { BrandIcon } from './brand/BrandIcon';
import { recordSourceLabel } from './usage/usageSummary';
import SessionAnalysisDrawer from './SessionAnalysisDrawer';
import type { SessionAnalysisRecord } from '../types/sessionAnalysis';
import { ContextComposition } from './usage/ContextComposition';
import '../styles/overviewDrill.css';
import { getLang, t, useLang, type Lang } from '../i18n';

type SessionCopyState = {
  id: string;
  status: 'copying' | 'copied' | 'failed';
};

export interface DetailFilters {
  tools: string[];
  models: string[];
  machines: string[];
  search: string;
  /** 只看这些供应商账号的网关行（契约 §2.7），仅本机；从概览热力图选中账号点日期时设置。 */
  providers?: string[];
}

interface LogsTableProps {
  details: UsageDetailsResponse | null;
  filters: DetailFilters;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  scope: DataScope;
  range: RangeKey;
  customRange?: CustomDateRange | null;
  onFilterChange: (key: keyof DetailFilters, value: string | string[]) => void;
  onClearFilters: () => void;
  onRetry: () => void;
  onLoadMore: () => void;
  onOpenEntity: (kind: 'tool' | 'model', name: string, tool?: string) => void;
  /** 从总览下钻来的单日复盘：显示正在查看的日期与“返回原范围”入口（审计 P0-1）。 */
  dayDrill?: DayDrillCopy | null;
  onReturnFromDayDrill?: () => void;
  /** 作为用量 · 请求子页渲染时为 true：页面标题已由用量页给出，这里只留读屏与焦点落点。 */
  hasPageTitle?: boolean;
  /** 导出当前范围与筛选下的全部行为 CSV（不只是已加载的页）；不传则不显示入口。 */
  onExportCsv?: () => void;
  exporting?: boolean;
  /** The local ledger has no rows at all: the empty state offers a scan instead of clearing filters. */
  ledgerEmpty?: boolean;
  onScan?: () => void;
  scanBusy?: boolean;
}

export interface DetailActionCopy {
  busy: boolean;
  label: string;
  ariaLabel: string;
}

export function detailActionCopy(action: 'retry' | 'search' | 'loadMore', busy: boolean): DetailActionCopy {
  if (action === 'retry') {
    return busy
      ? { busy: true, label: t('logs.loading'), ariaLabel: t('logs.retry.busyAria') }
      : { busy: false, label: t('logs.retry.label'), ariaLabel: t('logs.retry.aria') };
  }
  if (action === 'search') {
    return busy
      ? { busy: true, label: t('logs.search.busy'), ariaLabel: t('logs.search.busyAria') }
      : { busy: false, label: t('logs.search.label'), ariaLabel: t('logs.search.aria') };
  }
  return busy
    ? { busy: true, label: t('logs.more.busy'), ariaLabel: t('logs.more.busyAria') }
    : { busy: false, label: t('logs.more.label'), ariaLabel: t('logs.more.aria') };
}

const TIMESTAMP_OPTIONS: Intl.DateTimeFormatOptions = {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
};
const TIMESTAMP_FORMATTERS: Record<Lang, Intl.DateTimeFormat> = {
  zh: new Intl.DateTimeFormat('zh-CN', TIMESTAMP_OPTIONS),
  en: new Intl.DateTimeFormat('en-US', TIMESTAMP_OPTIONS),
};

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return TIMESTAMP_FORMATTERS[getLang()].format(date);
}

/** 耗时：1 秒以内写毫秒，否则保留一位小数的秒。 */
function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** 每行的回调：父组件里用 ref 取最新值，对象本身一直不变，行组件的 memo 才不会被它打破。 */
interface LogRowActions {
  toggleExpanded: (rowKey: string) => void;
  openEntity: (kind: 'tool' | 'model', name: string, tool?: string) => void;
  toggleMachine: (machine: string) => void;
  analyze: (record: SessionAnalysisRecord) => void;
  copySession: (sessionId: string) => void;
}

interface LogRowProps {
  log: LogHistoryItem;
  rowKey: string;
  expanded: boolean;
  toolColor: string;
  machineSelected: boolean;
  singleToolFilter: string | null;
  scope: DataScope;
  detailsGranularity: UsageDetailsResponse['granularity'];
  sessionCopyStatus: SessionCopyState['status'] | null;
  actions: LogRowActions;
}

export function logRowKey(log: Pick<LogHistoryItem, 'id' | 'sessionId' | 'timestamp'>): string {
  return `${log.id}-${log.sessionId}-${log.timestamp}`;
}

/**
 * 一条明细及其展开行。只接收这一行用到的值，搜索框打字、展开别的行、
 * 「加载更多」追加新行时，已画好的行不再重新渲染（行数上千时每次按键原本要重算全部行）。
 */
const LogRow = memo(function LogRow({
  log,
  rowKey,
  expanded,
  toolColor,
  machineSelected,
  singleToolFilter,
  scope,
  detailsGranularity,
  sessionCopyStatus,
  actions,
}: LogRowProps) {
  // Memoized rows subscribe on their own so a language switch still repaints them.
  useLang();
  const machine = log.machineId || 'localhost';
  const cacheMetrics = cacheDetailMetrics(log);
  const cacheSplit = resolveCacheBreakdown(log);
  return (
    <>
      <tr className={expanded ? 'log-row-expanded' : ''}>
        <td className="log-mobile-summary">
          <div className="log-mobile-summary-topline">
            <button
              className="table-entity-link log-mobile-tool capitalize"
              type="button"
              onClick={() => actions.openEntity('tool', log.tool)}
              title={t('logs.openBoard', { name: log.tool })}
            >
              <span className="entity-dot" style={{ color: toolColor }} />
              {log.tool}
            </button>
            <time className="log-mobile-time font-mono" dateTime={log.timestamp}>{formatTimestamp(log.timestamp)}</time>
          </div>
          <button
            className="table-entity-link table-model-link log-mobile-model"
            type="button"
            onClick={() => actions.openEntity('model', log.model, singleToolFilter ?? log.tool)}
            title={t('logs.openBoard', { name: log.model })}
          >
            {log.model}
          </button>
          <div className="log-mobile-summary-stats" aria-label={t('logs.row.statsAria')}>
            <span><strong>{formatNum(log.inputTokens + log.outputTokens)}</strong><small>{t('logs.effectiveTokens')}</small></span>
            <span><strong>{formatEstimatedUsd(log.cost, 'record')}</strong><small>{t('logs.row.cost')}</small></span>
            {log.cachedTokens ? <span><strong>{formatNum(log.cachedTokens)}</strong><small>{t('logs.row.cache')}</small></span> : null}
          </div>
        </td>
        <td className="log-desktop-cell log-desktop-context">
          <button
            className="table-entity-link capitalize"
            type="button"
            onClick={() => actions.openEntity('tool', log.tool)}
            title={t('logs.openBoard', { name: log.tool })}
          >
            <BrandIcon name={log.tool} color={toolColor} size={15} />
            <span className="entity-dot" style={{ color: toolColor }} />
            {log.tool}
          </button>
        </td>
        <td className="log-desktop-cell log-desktop-context">
          <button
            className="table-entity-link table-model-link"
            type="button"
            onClick={() => actions.openEntity('model', log.model, singleToolFilter ?? log.tool)}
            title={t('logs.openBoard', { name: log.model })}
          >
            {log.model}
          </button>
        </td>
        <td className="log-desktop-cell text-right num">{formatNum(log.inputTokens)}</td>
        <td className="log-desktop-cell text-right num">{formatNum(log.outputTokens)}</td>
        <td className="log-desktop-cell text-right num text-tertiary">
          {log.cachedTokens ? formatNum(log.cachedTokens) : '—'}
        </td>
        <td className="log-desktop-cell text-right num">
          {formatEstimatedUsd(log.cost, 'record')}
        </td>
        <td className="log-desktop-cell font-mono text-xs text-faint">{formatTimestamp(log.timestamp)}</td>
        <td className="log-desktop-cell">
          <button
            className="machine-filter-button"
            type="button"
            aria-pressed={machineSelected}
            aria-label={machineSelected ? t('logs.machine.removeAria', { machine }) : t('logs.machine.addAria', { machine })}
            onClick={() => actions.toggleMachine(machine)}
            title={machineSelected ? t('logs.machine.removeTitle', { machine }) : t('logs.machine.addTitle', { machine })}
          >
            <span className="machine-filter-surface">
              <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="machine-filter-label">{machine}</span>
              {machineSelected && <Check className="machine-filter-check h-3 w-3" aria-hidden="true" />}
            </span>
          </button>
        </td>
        <td className="log-detail-toggle-cell">
          <button
            className="log-detail-toggle"
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? t('logs.row.collapse') : t('logs.row.expand')}
            onClick={() => actions.toggleExpanded(rowKey)}
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="log-detail-row">
          <td colSpan={10}>
            <div className="log-detail-grid">
              <div><span>{t('logs.detail.input')}</span><strong>{formatNum(log.inputTokens)}</strong></div>
              <div><span>{t('logs.detail.output')}</span><strong>{formatNum(log.outputTokens)}</strong></div>
              {cacheMetrics.map((metric) => (
                <div key={metric.label}>
                  <span>{t(CACHE_METRIC_LABEL_KEY[metric.label])}</span>
                  <strong>{formatNum(metric.tokens)}</strong>
                </div>
              ))}
              {(() => {
                const hit = cacheSplit.kind === 'split' ? cacheHitRate(log.inputTokens, cacheSplit.read) : null;
                return hit === null ? null : <div><span>{t('logs.cacheHit')}</span><strong>{(hit * 100).toFixed(1)}%</strong></div>;
              })()}
              {(() => {
                const speed = outputTokensPerSecond(log.outputTokens, log.latencyMs);
                return log.latencyMs ? (
                  <>
                    <div><span>{t('logs.detail.latency')}</span><strong>{formatLatency(log.latencyMs)}</strong></div>
                    {speed !== null && <div title={t('logs.speed.title')}><span>{t('logs.speed')}</span><strong>{speed.toFixed(1)} tok/s</strong></div>}
                  </>
                ) : null;
              })()}
              <div><span>{t('logs.records')}</span><strong>{formatNum(log.requests || 1)}</strong></div>
              <div><span>{t('logs.detail.granularity')}</span><strong>{rowGranularityLabel(log, { granularity: detailsGranularity })}</strong></div>
              <div><span>{t('logs.detail.source')}</span><strong>{recordSourceLabel(log)}</strong></div>
              {log.provider && <div className="log-detail-wide"><span>{t('logs.detail.provider')}</span><code title={log.provider}>{log.provider}</code></div>}
              <div className="log-detail-wide"><span>{t('logs.detail.modelId')}</span><code title={log.model}>{log.model}</code></div>
              <div className="log-detail-wide"><span>Session ID</span><code title={log.sessionId || '—'}>{log.sessionId || '—'}</code></div>
              <div className="log-detail-wide"><span>{t('logs.detail.fullTime')}</span><code title={log.timestamp}>{log.timestamp}</code></div>
              <ContextComposition log={log} />
            </div>
            <div className="log-detail-actions">
              {scope === 'local' && log.sessionId && Number.isSafeInteger(log.id) && log.id > 0 && ['claude', 'codex'].includes(log.tool.toLowerCase()) && (
                <button className="ghost-inline" type="button" onClick={() => actions.analyze({ id: log.id, sessionId: log.sessionId, tool: log.tool })}>{t('logs.analyze')}</button>
              )}
              {scope !== 'local' && log.sessionId && <span className="text-xs text-muted">{t('logs.analyzeElsewhere')}</span>}
              {isEstimatedLogItem(log) && <span className="estimated-badge">{t('logs.estimated')}</span>}
              {log.sessionId && (
                (() => {
                  const isSessionCopying = sessionCopyStatus === 'copying';
                  const isSessionCopyFailed = sessionCopyStatus === 'failed';
                  const isSessionCopied = sessionCopyStatus === 'copied';
                  return <button
                    className={`ghost-inline log-session-copy-action${isSessionCopyFailed ? ' is-failed' : ''}${isSessionCopied ? ' is-success' : ''}`}
                    type="button"
                    aria-label={isSessionCopying
                      ? t('logs.copy.busy')
                      : isSessionCopyFailed
                        ? t('logs.copy.failedAria')
                        : isSessionCopied
                          ? t('logs.copy.done')
                          : t('logs.copy.action')}
                    title={isSessionCopying ? t('logs.copy.busy') : isSessionCopyFailed ? t('logs.copy.failedTitle') : log.sessionId}
                    disabled={isSessionCopying}
                    aria-busy={isSessionCopying || undefined}
                    onClick={() => { if (!isSessionCopying) actions.copySession(log.sessionId!); }}
                  >
                    {isSessionCopying
                      ? <LoaderCircle className="h-4 w-4 animate-spin" />
                      : isSessionCopied
                        ? <Check className="h-4 w-4" />
                        : <Copy className="h-4 w-4" />}
                    {isSessionCopying ? t('logs.copy.busyShort') : isSessionCopied ? t('logs.copy.doneShort') : isSessionCopyFailed ? t('logs.copy.failedShort') : t('logs.copy.action')}
                  </button>;
                })()
              )}
              <span className="sr-only" role="status" aria-live="polite">
                {sessionCopyStatus === 'copying'
                  ? t('logs.copy.busy')
                  : sessionCopyStatus === 'copied'
                    ? t('logs.copy.done')
                    : sessionCopyStatus === 'failed'
                      ? t('logs.copy.failedStatus')
                      : ''}
              </span>
              {sessionCopyStatus === 'failed' && (
                <span className="log-session-copy-hint">{t('logs.copy.failedHint')}</span>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
});

export function LogsTable({
  details,
  filters,
  loading,
  loadingMore,
  error,
  scope,
  range,
  customRange = null,
  onFilterChange,
  onClearFilters,
  onRetry,
  onLoadMore,
  onOpenEntity,
  dayDrill = null,
  onReturnFromDayDrill,
  hasPageTitle = false,
  onExportCsv,
  exporting = false,
  ledgerEmpty = false,
  onScan,
  scanBusy = false,
}: LogsTableProps) {
  useLang();
  const { effective } = useTheme();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [analysisRecord, setAnalysisRecord] = useState<SessionAnalysisRecord | null>(null);
  const [sessionCopyState, setSessionCopyState] = useState<SessionCopyState | null>(null);
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const tableScrollCueRef = useRef<HTMLButtonElement>(null);
  const [hasMoreTableColumns, setHasMoreTableColumns] = useState(false);
  const debounceTimerRef = useRef<number | null>(null);

  useEffect(() => { setAnalysisRecord(null); }, [scope]);

  const latest = useRef({ onOpenEntity, onFilterChange, machines: filters.machines });
  latest.current = { onOpenEntity, onFilterChange, machines: filters.machines };
  const rowActions = useMemo<LogRowActions>(() => ({
    toggleExpanded: (rowKey) => setExpandedKey((current) => (current === rowKey ? null : rowKey)),
    openEntity: (kind, name, tool) => latest.current.onOpenEntity(kind, name, tool),
    toggleMachine: (machine) => {
      const { machines, onFilterChange: change } = latest.current;
      change('machines', machines.includes(machine) ? machines.filter((item) => item !== machine) : [...machines, machine]);
    },
    analyze: setAnalysisRecord,
    copySession: async (sessionId) => {
      setSessionCopyState({ id: sessionId, status: 'copying' });
      try {
        if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(sessionId);
        setSessionCopyState({ id: sessionId, status: 'copied' });
        window.setTimeout(() => setSessionCopyState(null), 1600);
      } catch {
        setSessionCopyState({ id: sessionId, status: 'failed' });
      }
    },
  }), []);

  useEffect(() => {
    setSearchDraft(filters.search);
  }, [filters.search]);

  useEffect(() => {
    if (searchDraft === filters.search) {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      return;
    }

    debounceTimerRef.current = window.setTimeout(() => {
      onFilterChange('search', searchDraft);
      debounceTimerRef.current = null;
    }, 300);

    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [searchDraft, filters.search, onFilterChange]);

  const handleImmediateSearch = (value: string) => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (value !== filters.search) {
      onFilterChange('search', value);
    }
  };
  useEffect(() => {
    const element = tableWrapRef.current;
    if (!element) {
      setHasMoreTableColumns(false);
      return undefined;
    }

    const update = () => {
      const hasMore = element.scrollWidth - element.clientWidth - element.scrollLeft > 2;
      if (!hasMore && document.activeElement === tableScrollCueRef.current) {
        element.focus();
      }
      setHasMoreTableColumns(hasMore);
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);

    return () => {
      element.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [details?.items.length]);

  const scrollTableColumnsForward = () => {
    const table = tableWrapRef.current;
    if (!table) return;
    const maxScrollLeft = Math.max(0, table.scrollWidth - table.clientWidth);
    const nextScrollLeft = Math.min(
      maxScrollLeft,
      table.scrollLeft + Math.max(180, Math.round(table.clientWidth * 0.8)),
    );
    table.scrollTo({
      left: nextScrollLeft,
      behavior: typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    });
  };

  const handleTableScrollCueKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    scrollTableColumnsForward();
  };
  const accountFilter = filters.providers ?? [];
  const activeFilterCount = filters.tools.length + filters.models.length + filters.machines.length + accountFilter.length + (filters.search ? 1 : 0);
  // Same-view collision-shift for the tool dot: ranked by each tool's summed
  // effective tokens across the rows currently loaded (not just this page's
  // visual order), so the assignment stays stable as more rows load in via
  // "加载更多" instead of reshuffling on every page (T10.178 review P1-1).
  const toolColors = useMemo(() => {
    const totals = new Map<string, number>();
    for (const item of details?.items || []) {
      const key = (item.tool || '').toLowerCase();
      totals.set(key, (totals.get(key) || 0) + item.inputTokens + item.outputTokens);
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    return toolColorMap(ranked, effective);
  }, [details, effective]);
  const facets = details?.availableFilters || { tools: [], models: [], machines: [] };
  const summary = details?.filteredSummary;
  const summaryCacheSplit = summary ? resolveCacheBreakdown(summary) : null;
  const summaryCacheHit = summary && summaryCacheSplit?.kind === 'split' ? cacheHitRate(summary.inputTokens, summaryCacheSplit.read) : null;
  const summaryOutputSpeed = summary?.timedRequests ? outputTokensPerSecond(summary.timedOutputTokens, summary.timedLatencyMs) : null;
  const granularityLabel = detailGranularityLabel(details);
  const detailRetry = detailActionCopy('retry', loading);
  const detailSearch = detailActionCopy('search', loading);
  const detailLoadMore = detailActionCopy('loadMore', loadingMore);

  return (
    <div className="content-stack details-page">
      <div className="page-heading">
        <div>
          {hasPageTitle
            ? <h2 id="details-page-title" className="sr-only" tabIndex={-1}>{t('logs.title.sub')}</h2>
            : <h1 id="details-page-title" className="page-title" tabIndex={-1}>{t('logs.title')}</h1>}
          <p className="page-subtitle">
            {t('logs.subtitle')}
          </p>
        </div>
        <div className="details-context-badges" aria-label={t('logs.scopeAria')}>
          <span>{scope === 'cloud' ? t('logs.scope.cloud') : t('logs.scope.local')}</span>
          <span>{range === 'custom' ? rangeDisplayName('custom', customRange) : range === 'today' ? t('logs.range.today') : range === 'week' ? t('logs.range.week') : range === 'month' ? t('logs.range.month') : range === 'year' ? t('logs.range.year') : t('logs.range.all')}</span>
          <span>{granularityLabel}</span>
        </div>
      </div>

      {dayDrill && onReturnFromDayDrill && (
        <div className="details-day-drill" role="group" aria-label={t('logs.drill.aria', { day: dayDrill.day })}>
          <CalendarDays className="details-day-drill-icon h-4 w-4" aria-hidden="true" />
          <span className="details-day-drill-text">
            {t('logs.drill.viewing', { day: dayDrill.day })}
            <span className="details-day-drill-origin">{t('logs.drill.from', { origin: dayDrill.origin })}</span>
          </span>
          <button
            type="button"
            className="secondary-inline details-day-drill-return"
            onClick={onReturnFromDayDrill}
            aria-label={dayDrill.returnAriaLabel}
            title={dayDrill.returnAriaLabel}
          >
            <Undo2 className="h-4 w-4" aria-hidden="true" />
            {dayDrill.returnLabel}
          </button>
        </div>
      )}

      <section className={`panel detail-filter-panel${mobileFiltersOpen ? ' is-mobile-filters-open' : ''}`} aria-label={t('logs.filter.aria')} aria-busy={loading || undefined}>
        <div className="detail-filter-heading">
          <div>
            <div className="panel-title">
              <Filter className="h-4 w-4 text-primary" />
              {t('logs.filter.title')}
              {activeFilterCount > 0 && <span className="filter-count-badge">{activeFilterCount}</span>}
            </div>
          </div>
          <div className="detail-filter-heading-actions">
            <button
              className="detail-filter-toggle"
              type="button"
              aria-expanded={mobileFiltersOpen}
              aria-controls="detail-filter-controls"
              onClick={() => setMobileFiltersOpen((open) => !open)}
            >
              <Filter className="h-4 w-4" aria-hidden="true" />
              {mobileFiltersOpen ? t('logs.filter.collapse') : t('logs.filter.expand')}
              <ChevronDown className={`detail-filter-toggle-icon${mobileFiltersOpen ? ' is-open' : ''}`} aria-hidden="true" />
            </button>
            <button
              className="ghost-inline"
              type="button"
              onClick={onClearFilters}
              disabled={activeFilterCount === 0 || loading}
            >
              <RotateCcw className="h-4 w-4" />
              {t('logs.filter.clear')}
            </button>
          </div>
        </div>
        <div id="detail-filter-controls" className="detail-filter-grid">
          <FilterMultiSelect
            label={t('logs.col.tool')}
            values={filters.tools}
            options={facets.tools}
            disabled={loading}
            onChange={(values) => onFilterChange('tools', values)}
          />
          <FilterMultiSelect
            label={t('logs.col.model')}
            values={filters.models}
            options={facets.models}
            disabled={loading}
            onChange={(values) => onFilterChange('models', values)}
          />
          <FilterMultiSelect
            label={t('logs.col.machine')}
            values={filters.machines}
            options={facets.machines}
            disabled={loading}
            onChange={(values) => onFilterChange('machines', values)}
          />
          <form
            className="detail-search-control"
            onSubmit={(event) => {
              event.preventDefault();
              handleImmediateSearch(searchDraft);
            }}
          >
            <span className="detail-filter-label">{t('logs.search.title')}</span>
            <div className="detail-search-input">
              <Search className="h-4 w-4" aria-hidden="true" />
              <input
                value={searchDraft}
                maxLength={256}
                placeholder={t('logs.search.placeholder')}
                aria-label={t('logs.search.inputAria')}
                onChange={(event) => setSearchDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleImmediateSearch(searchDraft);
                  }
                }}
              />
              {searchDraft && (
                <button
                  type="button"
                  aria-label={t('logs.search.clear')}
                  onClick={() => {
                    setSearchDraft('');
                    handleImmediateSearch('');
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="submit"
                className="detail-search-submit"
                disabled={loading || searchDraft === filters.search}
                aria-label={detailSearch.ariaLabel}
                title={detailSearch.ariaLabel}
                aria-busy={detailSearch.busy || undefined}
              >
                {detailSearch.label}
              </button>
            </div>
          </form>
        </div>
        {accountFilter.length > 0 && (
          <div className="detail-account-filter" role="group" aria-label={t('logs.account.aria')}>
            <span className="detail-filter-label">{t('logs.account.label')}</span>
            {accountFilter.map((provider) => (
              <span key={provider} className="detail-account-chip">
                {provider}
                <button
                  type="button"
                  aria-label={t('logs.account.removeAria', { provider })}
                  title={t('logs.account.removeTitle')}
                  disabled={loading}
                  onClick={() => onFilterChange('providers', accountFilter.filter((item) => item !== provider))}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </span>
            ))}
            <span className="detail-account-note">{t('logs.account.note')}</span>
          </div>
        )}
      </section>

      {summary && (
        <div className="details-summary" aria-live="polite">
          <div>
            <span>{t('logs.summary.matched')}</span>
            <strong>{formatNum(details?.totalCount || 0)}</strong>
          </div>
          <div>
            <span>{t('logs.effectiveTokens')}</span>
            <strong>{formatTokens(summary.inputTokens + summary.outputTokens)}</strong>
          </div>
          <div>
            <span>{t('logs.records')}</span>
            <strong>{formatNum(summary.totalRequests)}</strong>
          </div>
          <div>
            <span>{t('logs.summary.cost')}</span>
            <strong>{formatEstimatedUsd(summary.totalCost)}</strong>
          </div>
          <div title={t('logs.summary.hitTitle')}>
            <span>{t('logs.cacheHit')}</span>
            <strong>{summaryCacheHit === null ? t('logs.summary.unavailable') : `${(summaryCacheHit * 100).toFixed(1)}%`}</strong>
          </div>
          {summaryOutputSpeed !== null && (
            <div title={t('logs.summary.speedTitle', { count: formatNum(summary.timedRequests || 0) })}>
              <span>{t('logs.speed')}</span>
              <strong>{summaryOutputSpeed.toFixed(1)} tok/s</strong>
            </div>
          )}
        </div>
      )}

      <section className="panel logs-panel" aria-busy={loading || loadingMore}>
        <div className="logs-panel-head">
          <div className="panel-title">
            <History className="h-4 w-4 text-primary" />
            {t('logs.table.title')}
          </div>
          <button
            ref={tableScrollCueRef}
            className={`log-table-scroll-cue${hasMoreTableColumns ? ' is-visible' : ''}`}
            type="button"
            aria-label={t('logs.table.moreAria')}
            title={t('logs.table.moreAria')}
            aria-controls="detail-log-table"
            aria-hidden={!hasMoreTableColumns}
            tabIndex={hasMoreTableColumns ? 0 : -1}
            onClick={scrollTableColumnsForward}
            onKeyDown={handleTableScrollCueKeyDown}
          >
            <ChevronRight className="h-3.5 w-3.5" />
            {t('logs.table.more')}
          </button>
          {details && (
            <span className="logs-result-count">
              {t('logs.table.shown', { shown: formatNum(details.items.length), total: formatNum(details.totalCount) })}
            </span>
          )}
          {onExportCsv && (
            <button
              type="button"
              className="secondary-inline logs-export"
              onClick={onExportCsv}
              disabled={!details || details.totalCount === 0 || exporting || loading}
              aria-busy={exporting || undefined}
              title={t('logs.export.title')}
            >
              {exporting ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
              {exporting ? t('logs.export.busy') : t('logs.export.action')}
            </button>
          )}
        </div>

        {error && !details ? (
          <div className="details-state details-state-error" role="alert">
            <strong>{t('logs.error.title')}</strong>
            <span>{error}</span>
            <button
              className="secondary-inline"
              type="button"
              onClick={onRetry}
              disabled={detailRetry.busy}
              aria-label={detailRetry.ariaLabel}
              title={detailRetry.ariaLabel}
              aria-busy={detailRetry.busy || undefined}
            >
              <RotateCcw className={`h-4 w-4 ${detailRetry.busy ? 'animate-spin' : ''}`} />
              {detailRetry.label}
            </button>
          </div>
        ) : loading && !details ? (
          <div className="details-state" role="status" aria-live="polite">
            <LoaderCircle className="h-5 w-5 animate-spin" />
            <span>{t('logs.reading')}</span>
          </div>
        ) : ledgerEmpty && activeFilterCount === 0 && (!details || details.items.length === 0) ? (
          <EmptyState variant="inset" icon={FolderSearch} title={t('logs.empty.title')} description={t('logs.empty.description')}>
            {onScan && (
              <button className="primary-inline" type="button" onClick={onScan} disabled={scanBusy} aria-busy={scanBusy || undefined}>
                <RefreshCw className={`h-4 w-4 ${scanBusy ? 'animate-spin' : ''}`} />
                {t('logs.empty.scan')}
              </button>
            )}
          </EmptyState>
        ) : !details || details.items.length === 0 ? (
          <div className="details-state">
            <strong>{t('logs.noMatch.title')}</strong>
            <span>{t('logs.noMatch.hint')}</span>
            {activeFilterCount > 0 && (
              <button className="secondary-inline" type="button" onClick={onClearFilters}>
                <RotateCcw className="h-4 w-4" />
                {t('logs.noMatch.reset')}
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="log-table-shell">
              <div
                ref={tableWrapRef}
                id="detail-log-table"
                className="log-table-wrap tl-scrollbar"
                role="region"
                aria-label={t('logs.table.aria')}
                tabIndex={0}
              >
              <table className="log-table">
                <thead>
                  <tr>
                    <th scope="col" className="log-mobile-summary">{t('logs.col.summary')}</th>
                    <th scope="col" className="log-desktop-cell log-desktop-context">{t('logs.col.tool')}</th>
                    <th scope="col" className="log-desktop-cell log-desktop-context">{t('logs.col.model')}</th>
                    <th scope="col" className="log-desktop-cell text-right">{t('logs.col.input')}</th>
                    <th scope="col" className="log-desktop-cell text-right">{t('logs.col.output')}</th>
                    <th scope="col" className="log-desktop-cell text-right">{t('logs.cache.total')}</th>
                    <th scope="col" className="log-desktop-cell text-right">{t('logs.summary.cost')}</th>
                    <th scope="col" className="log-desktop-cell">{t('logs.col.time')}</th>
                    <th scope="col" className="log-desktop-cell">{t('logs.col.machine')}</th>
                    <th scope="col"><span className="sr-only">{t('logs.col.expand')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {details.items.map((log) => {
                    const rowKey = logRowKey(log);
                    return (
                      <LogRow
                        key={rowKey}
                        log={log}
                        rowKey={rowKey}
                        expanded={expandedKey === rowKey}
                        toolColor={toolColors.get(log.tool.toLowerCase()) ?? colorForTool(log.tool, 0, effective)}
                        machineSelected={filters.machines.includes(log.machineId || 'localhost')}
                        singleToolFilter={filters.tools.length === 1 ? filters.tools[0] : null}
                        scope={scope}
                        detailsGranularity={details.granularity}
                        sessionCopyStatus={log.sessionId && sessionCopyState?.id === log.sessionId ? sessionCopyState.status : null}
                        actions={rowActions}
                      />
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>
            {error && (
              <div className="details-load-more-error" role="alert">
                <span>{t('logs.more.failed', { error })}</span>
                <button
                  className="secondary-inline"
                  type="button"
                  onClick={onLoadMore}
                  disabled={detailLoadMore.busy}
                  aria-label={detailLoadMore.busy ? t('logs.more.retryBusyAria') : t('logs.more.retryAria')}
                  title={detailLoadMore.busy ? t('logs.more.retryBusyAria') : t('logs.more.retryAria')}
                  aria-busy={detailLoadMore.busy || undefined}
                >
                  {detailLoadMore.busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                  {detailLoadMore.busy ? t('logs.loading') : t('logs.more.retry')}
                </button>
              </div>
            )}
            {details.hasMore && !error && (
              <div className="details-load-more">
                <button
                  className="secondary-inline"
                  type="button"
                  onClick={onLoadMore}
                  disabled={detailLoadMore.busy}
                  aria-label={detailLoadMore.ariaLabel}
                  title={detailLoadMore.ariaLabel}
                  aria-busy={detailLoadMore.busy || undefined}
                >
                  {detailLoadMore.busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}
                  {detailLoadMore.label}
                </button>
              </div>
            )}
          </>
        )}
      </section>
      {scope === 'local' && analysisRecord && <SessionAnalysisDrawer record={analysisRecord} onClose={() => setAnalysisRecord(null)} />}
    </div>
  );
}

export default LogsTable;
