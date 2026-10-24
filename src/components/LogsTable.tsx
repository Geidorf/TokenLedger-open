import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { CalendarDays, Check, ChevronDown, ChevronRight, Copy, Download, Filter, FolderSearch, History, LoaderCircle, Monitor, RefreshCw, RotateCcw, Search, Undo2, X } from 'lucide-react';
import { EmptyState } from './EmptyState';
import type { DayDrillCopy } from '../hooks/useDayDrill';
import type { CustomDateRange, DataScope, LogHistoryItem, RangeKey, UsageDetailsResponse } from '../types';
import { colorForTool, isEstimatedLogItem, toolColorMap } from '../types';
import { cacheDetailMetrics, resolveCacheBreakdown } from '../utils/cacheDisplay';
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
      ? { busy: true, label: '加载中…', ariaLabel: '正在加载消耗明细' }
      : { busy: false, label: '重新加载', ariaLabel: '重新加载消耗明细' };
  }
  if (action === 'search') {
    return busy
      ? { busy: true, label: '应用中…', ariaLabel: '正在应用明细搜索' }
      : { busy: false, label: '应用搜索', ariaLabel: '应用明细搜索' };
  }
  return busy
    ? { busy: true, label: '正在加载…', ariaLabel: '正在加载下一页消耗明细' }
    : { busy: false, label: '加载更多', ariaLabel: '加载更多消耗明细' };
}

const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return TIMESTAMP_FORMATTER.format(date);
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
  const machine = log.machineId || 'localhost';
  const cacheMetrics = cacheDetailMetrics(log);
  return (
    <>
      <tr className={expanded ? 'log-row-expanded' : ''}>
        <td className="log-mobile-summary">
          <div className="log-mobile-summary-topline">
            <button
              className="table-entity-link log-mobile-tool capitalize"
              type="button"
              onClick={() => actions.openEntity('tool', log.tool)}
              title={`打开 ${log.tool} 专属看板`}
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
            title={`打开 ${log.model} 专属看板`}
          >
            {log.model}
          </button>
          <div className="log-mobile-summary-stats" aria-label="记录摘要指标">
            <span><strong>{formatNum(log.inputTokens + log.outputTokens)}</strong><small>有效 Token</small></span>
            <span><strong>{formatEstimatedUsd(log.cost, 'record')}</strong><small>费用</small></span>
            {log.cachedTokens ? <span><strong>{formatNum(log.cachedTokens)}</strong><small>缓存</small></span> : null}
          </div>
        </td>
        <td className="log-desktop-cell log-desktop-context">
          <button
            className="table-entity-link capitalize"
            type="button"
            onClick={() => actions.openEntity('tool', log.tool)}
            title={`打开 ${log.tool} 专属看板`}
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
            title={`打开 ${log.model} 专属看板`}
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
            aria-label={machineSelected ? `从设备筛选中移除 ${machine}` : `按设备筛选 ${machine}`}
            onClick={() => actions.toggleMachine(machine)}
            title={machineSelected ? `移除设备筛选：${machine}` : `加入设备筛选：${machine}`}
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
            aria-label={expanded ? '收起此记录详情' : '展开此记录详情'}
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
              <div><span>输入 Tokens</span><strong>{formatNum(log.inputTokens)}</strong></div>
              <div><span>输出 Tokens</span><strong>{formatNum(log.outputTokens)}</strong></div>
              {cacheMetrics.map((metric) => (
                <div key={metric.label}>
                  <span>{metric.label}</span>
                  <strong>{formatNum(metric.tokens)}</strong>
                </div>
              ))}
              {(() => {
                const read = cacheMetrics.find((metric) => metric.label === '缓存读取');
                const hit = read ? cacheHitRate(log.inputTokens, read.tokens) : null;
                return hit === null ? null : <div><span>缓存命中率</span><strong>{(hit * 100).toFixed(1)}%</strong></div>;
              })()}
              {(() => {
                const speed = outputTokensPerSecond(log.outputTokens, log.latencyMs);
                return log.latencyMs ? (
                  <>
                    <div><span>耗时</span><strong>{formatLatency(log.latencyMs)}</strong></div>
                    {speed !== null && <div title="输出 Token ÷ 整次请求耗时（含首字等待）"><span>输出速度</span><strong>{speed.toFixed(1)} tok/s</strong></div>}
                  </>
                ) : null;
              })()}
              <div><span>记录数</span><strong>{formatNum(log.requests || 1)}</strong></div>
              <div><span>数据粒度</span><strong>{rowGranularityLabel(log, { granularity: detailsGranularity })}</strong></div>
              <div><span>来源</span><strong>{recordSourceLabel(log)}</strong></div>
              {log.provider && <div className="log-detail-wide"><span>供应商</span><code title={log.provider}>{log.provider}</code></div>}
              <div className="log-detail-wide"><span>模型 ID</span><code title={log.model}>{log.model}</code></div>
              <div className="log-detail-wide"><span>Session ID</span><code title={log.sessionId || '—'}>{log.sessionId || '—'}</code></div>
              <div className="log-detail-wide"><span>完整时间</span><code title={log.timestamp}>{log.timestamp}</code></div>
              <ContextComposition log={log} />
            </div>
            <div className="log-detail-actions">
              {scope === 'local' && log.sessionId && Number.isSafeInteger(log.id) && log.id > 0 && ['claude', 'codex'].includes(log.tool.toLowerCase()) && (
                <button className="ghost-inline" type="button" onClick={() => actions.analyze({ id: log.id, sessionId: log.sessionId, tool: log.tool })}>分析整个会话</button>
              )}
              {scope !== 'local' && log.sessionId && <span className="text-xs text-muted">逐轮分析需在原始日志所在电脑的本地明细中打开。</span>}
              {isEstimatedLogItem(log) && <span className="estimated-badge">约数 · 来源日志未提供精确用量</span>}
              {log.sessionId && (
                (() => {
                  const isSessionCopying = sessionCopyStatus === 'copying';
                  const isSessionCopyFailed = sessionCopyStatus === 'failed';
                  const isSessionCopied = sessionCopyStatus === 'copied';
                  return <button
                    className={`ghost-inline log-session-copy-action${isSessionCopyFailed ? ' is-failed' : ''}${isSessionCopied ? ' is-success' : ''}`}
                    type="button"
                    aria-label={isSessionCopying
                      ? '正在复制 Session ID'
                      : isSessionCopyFailed
                        ? '复制失败，点击重试 Session ID'
                        : isSessionCopied
                          ? '已复制 Session ID'
                          : '复制 Session ID'}
                    title={isSessionCopying ? '正在复制 Session ID' : isSessionCopyFailed ? '剪贴板不可用，可选择上方完整 ID 或重试' : log.sessionId}
                    disabled={isSessionCopying}
                    aria-busy={isSessionCopying || undefined}
                    onClick={() => { if (!isSessionCopying) actions.copySession(log.sessionId!); }}
                  >
                    {isSessionCopying
                      ? <LoaderCircle className="h-4 w-4 animate-spin" />
                      : isSessionCopied
                        ? <Check className="h-4 w-4" />
                        : <Copy className="h-4 w-4" />}
                    {isSessionCopying ? '复制中…' : isSessionCopied ? '已复制' : isSessionCopyFailed ? '复制失败，重试' : '复制 Session ID'}
                  </button>;
                })()
              )}
              <span className="sr-only" role="status" aria-live="polite">
                {sessionCopyStatus === 'copying'
                  ? '正在复制 Session ID'
                  : sessionCopyStatus === 'copied'
                    ? '已复制 Session ID'
                    : sessionCopyStatus === 'failed'
                      ? '复制 Session ID 失败，可选择上方完整 ID 后手动复制，或点击重试'
                      : ''}
              </span>
              {sessionCopyStatus === 'failed' && (
                <span className="log-session-copy-hint">剪贴板不可用，可选择上方完整 ID 后手动复制。</span>
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
            ? <h2 id="details-page-title" className="sr-only" tabIndex={-1}>请求明细</h2>
            : <h1 id="details-page-title" className="page-title" tabIndex={-1}>消耗明细</h1>}
          <p className="page-subtitle">
            点击工具或模型，查看专属看板。
          </p>
        </div>
        <div className="details-context-badges" aria-label="当前明细范围">
          <span>{scope === 'cloud' ? '云端汇总' : '本地机器'}</span>
          <span>{range === 'custom' ? rangeDisplayName('custom', customRange) : range === 'today' ? '今日' : range === 'week' ? '本周' : range === 'month' ? '本月' : range === 'year' ? '今年' : '全部'}</span>
          <span>{granularityLabel}</span>
        </div>
      </div>

      {dayDrill && onReturnFromDayDrill && (
        <div className="details-day-drill" role="group" aria-label={`单日复盘：${dayDrill.day}`}>
          <CalendarDays className="details-day-drill-icon h-4 w-4" aria-hidden="true" />
          <span className="details-day-drill-text">
            正在查看 {dayDrill.day}
            <span className="details-day-drill-origin"> · 来自{dayDrill.origin}</span>
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

      <section className={`panel detail-filter-panel${mobileFiltersOpen ? ' is-mobile-filters-open' : ''}`} aria-label="消耗明细筛选" aria-busy={loading || undefined}>
        <div className="detail-filter-heading">
          <div>
            <div className="panel-title">
              <Filter className="h-4 w-4 text-primary" />
              精确筛选
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
              {mobileFiltersOpen ? '收起筛选' : '展开筛选'}
              <ChevronDown className={`detail-filter-toggle-icon${mobileFiltersOpen ? ' is-open' : ''}`} aria-hidden="true" />
            </button>
            <button
              className="ghost-inline"
              type="button"
              onClick={onClearFilters}
              disabled={activeFilterCount === 0 || loading}
            >
              <RotateCcw className="h-4 w-4" />
              清除筛选
            </button>
          </div>
        </div>
        <div id="detail-filter-controls" className="detail-filter-grid">
          <FilterMultiSelect
            label="工具"
            values={filters.tools}
            options={facets.tools}
            disabled={loading}
            onChange={(values) => onFilterChange('tools', values)}
          />
          <FilterMultiSelect
            label="模型"
            values={filters.models}
            options={facets.models}
            disabled={loading}
            onChange={(values) => onFilterChange('models', values)}
          />
          <FilterMultiSelect
            label="设备"
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
            <span className="detail-filter-label">文本搜索</span>
            <div className="detail-search-input">
              <Search className="h-4 w-4" aria-hidden="true" />
              <input
                value={searchDraft}
                maxLength={256}
                placeholder="搜索字段或 Session"
                aria-label="搜索工具、模型、设备或 Session"
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
                  aria-label="清除文本搜索"
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
          <div className="detail-account-filter" role="group" aria-label="账号筛选">
            <span className="detail-filter-label">账号</span>
            {accountFilter.map((provider) => (
              <span key={provider} className="detail-account-chip">
                {provider}
                <button
                  type="button"
                  aria-label={`移除账号筛选：${provider}`}
                  title="移除账号筛选"
                  disabled={loading}
                  onClick={() => onFilterChange('providers', accountFilter.filter((item) => item !== provider))}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </span>
            ))}
            <span className="detail-account-note">只含经网关记录的请求</span>
          </div>
        )}
      </section>

      {summary && (
        <div className="details-summary" aria-live="polite">
          <div>
            <span>匹配记录</span>
            <strong>{formatNum(details?.totalCount || 0)}</strong>
          </div>
          <div>
            <span>有效 Token</span>
            <strong>{formatTokens(summary.inputTokens + summary.outputTokens)}</strong>
          </div>
          <div>
            <span>记录数</span>
            <strong>{formatNum(summary.totalRequests)}</strong>
          </div>
          <div>
            <span>预估费用</span>
            <strong>{formatEstimatedUsd(summary.totalCost)}</strong>
          </div>
          <div title="缓存读 ÷（输入 + 缓存读）；来源没有给出缓存读写拆分时不可得">
            <span>缓存命中率</span>
            <strong>{summaryCacheHit === null ? '不可得' : `${(summaryCacheHit * 100).toFixed(1)}%`}</strong>
          </div>
          {summaryOutputSpeed !== null && (
            <div title={`按 ${formatNum(summary.timedRequests || 0)} 条带耗时的网关记录：输出 Token 合计 ÷ 耗时合计（含首字等待）`}>
              <span>输出速度</span>
              <strong>{summaryOutputSpeed.toFixed(1)} tok/s</strong>
            </div>
          )}
        </div>
      )}

      <section className="panel logs-panel" aria-busy={loading || loadingMore}>
        <div className="logs-panel-head">
          <div className="panel-title">
            <History className="h-4 w-4 text-primary" />
            明细记录
          </div>
          <button
            ref={tableScrollCueRef}
            className={`log-table-scroll-cue${hasMoreTableColumns ? ' is-visible' : ''}`}
            type="button"
            aria-label="向右查看更多字段"
            title="向右查看更多字段"
            aria-controls="detail-log-table"
            aria-hidden={!hasMoreTableColumns}
            tabIndex={hasMoreTableColumns ? 0 : -1}
            onClick={scrollTableColumnsForward}
            onKeyDown={handleTableScrollCueKeyDown}
          >
            <ChevronRight className="h-3.5 w-3.5" />
            横向查看更多字段
          </button>
          {details && (
            <span className="logs-result-count">
              已显示 {formatNum(details.items.length)} / {formatNum(details.totalCount)}
            </span>
          )}
          {onExportCsv && (
            <button
              type="button"
              className="secondary-inline logs-export"
              onClick={onExportCsv}
              disabled={!details || details.totalCount === 0 || exporting || loading}
              aria-busy={exporting || undefined}
              title="导出当前范围与筛选下的全部行，不只是已显示的部分"
            >
              {exporting ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
              {exporting ? '导出中…' : '导出 CSV'}
            </button>
          )}
        </div>

        {error && !details ? (
          <div className="details-state details-state-error" role="alert">
            <strong>明细暂时不可用</strong>
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
            <span>正在读取完整明细与可用筛选项…</span>
          </div>
        ) : ledgerEmpty && activeFilterCount === 0 && (!details || details.items.length === 0) ? (
          <EmptyState variant="inset" icon={FolderSearch} title="本机还没有请求记录" description="扫描本机日志后，每一次调用的时间、模型、Token 与费用都会列在这里，可以按工具、模型和设备筛选。">
            {onScan && (
              <button className="primary-inline" type="button" onClick={onScan} disabled={scanBusy} aria-busy={scanBusy || undefined}>
                <RefreshCw className={`h-4 w-4 ${scanBusy ? 'animate-spin' : ''}`} />
                扫描本机日志
              </button>
            )}
          </EmptyState>
        ) : !details || details.items.length === 0 ? (
          <div className="details-state">
            <strong>没有匹配记录</strong>
            <span>尝试清除部分筛选，或切换统计时间范围。</span>
            {activeFilterCount > 0 && (
              <button className="secondary-inline" type="button" onClick={onClearFilters}>
                <RotateCcw className="h-4 w-4" />
                清除筛选并恢复
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
                aria-label="明细记录表格，可横向滚动查看更多字段"
                tabIndex={0}
              >
              <table className="log-table">
                <thead>
                  <tr>
                    <th scope="col" className="log-mobile-summary">记录摘要</th>
                    <th scope="col" className="log-desktop-cell log-desktop-context">工具</th>
                    <th scope="col" className="log-desktop-cell log-desktop-context">模型</th>
                    <th scope="col" className="log-desktop-cell text-right">输入</th>
                    <th scope="col" className="log-desktop-cell text-right">输出</th>
                    <th scope="col" className="log-desktop-cell text-right">缓存合计</th>
                    <th scope="col" className="log-desktop-cell text-right">预估费用</th>
                    <th scope="col" className="log-desktop-cell">时间</th>
                    <th scope="col" className="log-desktop-cell">设备</th>
                    <th scope="col"><span className="sr-only">展开详情</span></th>
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
                <span>加载下一页失败：{error}</span>
                <button
                  className="secondary-inline"
                  type="button"
                  onClick={onLoadMore}
                  disabled={detailLoadMore.busy}
                  aria-label={detailLoadMore.busy ? '正在重试加载下一页消耗明细' : '重试加载下一页消耗明细'}
                  title={detailLoadMore.busy ? '正在重试加载下一页消耗明细' : '重试加载下一页消耗明细'}
                  aria-busy={detailLoadMore.busy || undefined}
                >
                  {detailLoadMore.busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                  {detailLoadMore.busy ? '加载中…' : '重试加载'}
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
