import { useId } from 'react';
import { History, RotateCcw } from 'lucide-react';
import type { UsageDetailsResponse } from '../../types';
import { formatEstimatedUsd, formatLocalDateTime, formatNum, formatTokens } from '../../utils/format';
import { InfoTip } from '../InfoTip';
import { LoadingSkeleton } from '../LoadingSkeleton';
import { BrandIcon } from '../brand/BrandIcon';
import type { DetailFilters } from '../LogsTable';
import { recordSourceLabel } from './usageSummary';

export interface UsageRecordsPanelProps {
  details: UsageDetailsResponse | null;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  /** 活动明细里设置的筛选同样作用于这里；有筛选时提示一句，避免把筛选结果当全部。 */
  filtered: boolean;
  filters?: DetailFilters;
  onClearFilters?: () => void;
  onRetry: () => void;
  onLoadMore: () => void;
  onOpenDetails: () => void;
}

export function describeActiveFilters(filters?: DetailFilters): string {
  if (!filters) return '';
  const parts: string[] = [];
  if (filters.tools.length > 0) parts.push(`工具 ${filters.tools.join(', ')}`);
  if (filters.models.length > 0) parts.push(`模型 ${filters.models.join(', ')}`);
  if (filters.machines.length > 0) parts.push(`设备 ${filters.machines.join(', ')}`);
  const trimmedSearch = filters.search.trim();
  if (trimmedSearch) parts.push(`搜索 "${trimmedSearch}"`);
  return parts.join(' · ');
}

const cell = (value: number | undefined) => (value === undefined ? '—' : formatNum(value));

/** 逐请求记录（T10.262 原型「记录」）：网关与日志扫描合并后的同一份明细，重复请求只计一次（契约 §2.5）。 */
export function UsageRecordsPanel({
  details,
  loading,
  loadingMore,
  error,
  filtered,
  filters,
  onClearFilters,
  onRetry,
  onLoadMore,
  onOpenDetails,
}: UsageRecordsPanelProps) {
  const scrollHintId = useId();
  if (error) {
    return (
      <div className="usage-card usage-empty" role="alert">
        <span>读取记录失败：{error}</span>
        <button type="button" className="usage-btn" onClick={onRetry}>重试</button>
      </div>
    );
  }
  if (!details) return loading ? <LoadingSkeleton className="h-64" /> : null;

  const summary = details.filteredSummary;
  const gatewayMerged = details.meta?.capabilities?.gatewayLedger === true;
  const filterSummary = filtered ? describeActiveFilters(filters) : '';
  return (
    <div className="usage-body usage-records">
      <p className="usage-sumline">
        <span>{formatNum(details.totalCount)} 条记录</span>
        <span>有效 Token {formatTokens(summary.totalTokens)}（输入 {formatTokens(summary.inputTokens)} · 输出 {formatTokens(summary.outputTokens)}）</span>
        {summary.cacheReadTokens !== undefined && summary.cacheWriteTokens !== undefined
          ? <span>缓存读 {formatTokens(summary.cacheReadTokens)} · 缓存写 {formatTokens(summary.cacheWriteTokens)}</span>
          : <span>缓存 {formatTokens(summary.cachedTokens)}</span>}
        <span>{formatEstimatedUsd(summary.totalCost)}</span>
        {gatewayMerged && (
          <InfoTip label="记录去重说明">网关记录与日志扫描到的同一请求只计一次，以网关记录为准</InfoTip>
        )}
        {filtered && (
          <span className="usage-sumline-note">
            已按活动明细中的筛选显示{filterSummary ? `（${filterSummary}）` : ''}
          </span>
        )}
        <span className="usage-flex" />
        {filtered && onClearFilters && (
          <button type="button" className="usage-btn" onClick={onClearFilters}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            清除筛选
          </button>
        )}
        <button type="button" className="usage-btn" onClick={onOpenDetails}><History className="h-3.5 w-3.5" aria-hidden="true" />筛选与搜索</button>
      </p>
      {details.items.length === 0 ? (
        <div className="usage-card usage-empty">
          <span>{filtered ? '当前筛选下没有匹配记录' : '当前范围没有记录'}</span>
          {filtered && onClearFilters && (
            <button type="button" className="usage-btn" onClick={onClearFilters}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              清除筛选
            </button>
          )}
        </div>
      ) : (
        <>
        <p className="usage-table-hint" id={scrollHintId}>表格可上下及左右滚动；聚焦表格后用方向键滚动，聚焦模型或供应商可查看完整名称。</p>
        <div className="usage-card usage-table-wrap tl-scrollbar" tabIndex={0} role="region" aria-label="用量记录滚动表格" aria-describedby={scrollHintId}>
          <table className="usage-table" aria-label="用量记录">
            <thead>
              <tr>
                <th scope="col">时间</th><th scope="col">工具</th><th scope="col">模型</th><th scope="col">供应商</th><th scope="col">来源</th>
                <th scope="col" className="is-num">输入</th><th scope="col" className="is-num">输出</th>
                <th scope="col" className="is-num">缓存读</th><th scope="col" className="is-num">缓存写</th><th scope="col" className="is-num">预估费用</th>
              </tr>
            </thead>
            <tbody>
              {details.items.map((item) => {
                const source = recordSourceLabel(item);
                return (
                  <tr key={`${item.id}-${item.timestamp}`}>
                    <td className="is-time">{formatLocalDateTime(item.timestamp)}</td>
                    <td>
                      <span className="usage-tool-cell">
                        <BrandIcon name={item.tool} size={15} />
                        <span>{item.tool}</span>
                      </span>
                    </td>
                    <td><span className="usage-table-identity" tabIndex={0} title={item.model}>{item.model}</span></td>
                    <td>{item.provider ? <span className="usage-table-identity" tabIndex={0} title={item.provider}>{item.provider}</span> : <span className="usage-faint">—</span>}</td>
                    <td className={source === '网关' ? 'usage-source is-gateway' : 'usage-source'}>{source}</td>
                    <td className="is-num">{formatNum(item.inputTokens)}</td>
                    <td className="is-num">{formatNum(item.outputTokens)}</td>
                    <td className="is-num">{cell(item.cacheReadTokens)}</td>
                    <td className="is-num">{cell(item.cacheWriteTokens)}</td>
                    <td className="is-num is-cost">{formatEstimatedUsd(item.cost, 'record')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}
      {details.hasMore && (
        <button type="button" className="usage-btn usage-more" onClick={onLoadMore} disabled={loadingMore} aria-busy={loadingMore || undefined}>
          {loadingMore ? '正在加载…' : '加载更多'}
        </button>
      )}
    </div>
  );
}
