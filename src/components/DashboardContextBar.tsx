import { CalendarRange, Clock3, Cloud, Database, Globe2 } from 'lucide-react';
import type { CustomDateRange, DataScope, RangeKey, StatsData } from '../types';
import { formatLocalDateTime } from '../utils/format';
import { rangeDisplayName } from '../utils/rangeDisplay';
import { InfoTip } from './InfoTip';

interface DashboardContextBarProps {
  scope: DataScope;
  range: RangeKey;
  customRange?: CustomDateRange | null;
  meta?: StatsData['meta'];
  refreshCompletedAt?: string;
  heldRangeNotice?: string;
  refreshError?: boolean;
}

export interface DashboardSnapshotCopy {
  label: string;
  detail: string;
  tone: 'neutral' | 'warning';
}

function validTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

export function dashboardSourceLabel(scope: DataScope, meta?: StatsData['meta']): string {
  if (scope === 'local') return '本机账本';
  const machines = meta?.query?.machines;
  if (!machines) return '云端 · 设备范围未回显';
  if (machines.length === 0) return '云端 · 全部设备';
  return `云端 · 已选 ${machines.length} 台设备`;
}

export function dashboardSnapshotCopy({
  meta,
  heldRangeNotice,
  refreshError,
}: Pick<DashboardContextBarProps, 'meta' | 'heldRangeNotice' | 'refreshError'>): DashboardSnapshotCopy {
  if (heldRangeNotice) {
    return { label: '旧范围快照', detail: heldRangeNotice, tone: 'warning' };
  }
  if (refreshError) {
    return { label: '最近可信快照', detail: '刷新失败，继续显示已验证的旧值', tone: 'warning' };
  }
  if (meta?.stale === true) {
    return { label: '旧快照', detail: '数据源已标记为非最新', tone: 'warning' };
  }
  if (meta?.stale === false) {
    return { label: '当前快照', detail: '数据源未标记为旧', tone: 'neutral' };
  }
  return { label: '快照状态未提供', detail: '数据源未回传新旧状态', tone: 'neutral' };
}

export function DashboardContextBar({
  scope,
  range,
  customRange = null,
  meta,
  refreshCompletedAt = '',
  heldRangeNotice = '',
  refreshError = false,
}: DashboardContextBarProps) {
  const snapshot = dashboardSnapshotCopy({ meta, heldRangeNotice, refreshError });
  const timezone = meta?.query?.timezone || meta?.timezone || null;
  const echoedRange = meta?.query?.range;
  const echoedCustomRange = echoedRange === 'custom' && meta?.query?.start && meta?.query?.end
    ? { start: meta.query.start, end: meta.query.end }
    : null;
  const rangeLabel = echoedRange
    ? rangeDisplayName(echoedRange, echoedCustomRange)
    : rangeDisplayName(range, customRange);
  const rangeCaption = echoedRange ? '统计周期' : heldRangeNotice ? '当前选择' : '统计周期';
  const rangeValue = !echoedRange && heldRangeNotice ? `${rangeLabel}（数据未更新）` : rangeLabel;
  const lastRefreshedAt = validTimestamp(meta?.lastRefreshedAt);
  const generatedAt = validTimestamp(meta?.generatedAt);
  const dataTimestamp = lastRefreshedAt || generatedAt;
  const operationTimestamp = validTimestamp(refreshCompletedAt);
  const operationDiffers = !!dataTimestamp && !!operationTimestamp
    && new Date(operationTimestamp).getTime() !== new Date(dataTimestamp).getTime();
  const timestampLabel = lastRefreshedAt ? '数据刷新于' : generatedAt ? '快照生成于' : null;

  const timestampText = dataTimestamp && timestampLabel
    ? `${timestampLabel} ${formatLocalDateTime(dataTimestamp)}`
    : operationTimestamp
      ? `界面刷新完成于 ${formatLocalDateTime(operationTimestamp)} · 数据时间未提供`
      : '更新时间不可得';

  // U-102：来源、周期与更新时间顶栏和工具行已显示，常态只留 ⓘ；快照可疑时才露出一个短状态词。
  return (
    <section className={`dashboard-context-bar is-${snapshot.tone}`} aria-label="当前看板上下文">
      {snapshot.tone === 'warning' && !heldRangeNotice && (
        <span className="dashboard-context-flag" title={snapshot.detail}>{snapshot.label}</span>
      )}
      <InfoTip label="看板数据来源与快照">
        <span className="dashboard-context-item">
          {scope === 'cloud' ? <Cloud className="h-3.5 w-3.5" aria-hidden="true" /> : <Database className="h-3.5 w-3.5" aria-hidden="true" />}
          <small>数据来源</small><strong>{dashboardSourceLabel(scope, meta)}</strong>
        </span>
        <span className="dashboard-context-item">
          <CalendarRange className="h-3.5 w-3.5" aria-hidden="true" />
          <small>{rangeCaption}</small><strong>{rangeValue}</strong>
        </span>
        <span className="dashboard-context-item">
          <Globe2 className="h-3.5 w-3.5" aria-hidden="true" />
          <small>统计时区</small><strong>{timezone ?? '未提供'}</strong>
        </span>
        <span className="dashboard-context-item">
          <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
          <small>{snapshot.label}</small><strong>{timestampText}</strong>
        </span>
        {snapshot.tone === 'warning' && <span className="dashboard-context-item">{snapshot.detail}</span>}
        {operationDiffers && operationTimestamp && (
          <span className="dashboard-context-item">界面刷新完成于 {formatLocalDateTime(operationTimestamp)}</span>
        )}
      </InfoTip>
    </section>
  );
}

export default DashboardContextBar;
