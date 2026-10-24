import { CalendarRange, Clock3, Cloud, Database, Globe2 } from 'lucide-react';
import type { CustomDateRange, DataScope, RangeKey, StatsData } from '../types';
import { formatLocalDateTime } from '../utils/format';
import { rangeDisplayName } from '../utils/rangeDisplay';
import { InfoTip } from './InfoTip';
import { t, useLang } from '../i18n';

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
  if (scope === 'local') return t('dctx.source.local');
  const machines = meta?.query?.machines;
  if (!machines) return t('dctx.source.cloudUnknown');
  if (machines.length === 0) return t('dctx.source.cloudAll');
  return t('dctx.source.cloudSome', { n: machines.length });
}

export function dashboardSnapshotCopy({
  meta,
  heldRangeNotice,
  refreshError,
}: Pick<DashboardContextBarProps, 'meta' | 'heldRangeNotice' | 'refreshError'>): DashboardSnapshotCopy {
  if (heldRangeNotice) {
    return { label: t('dctx.snap.held'), detail: heldRangeNotice, tone: 'warning' };
  }
  if (refreshError) {
    return { label: t('dctx.snap.lastGood'), detail: t('dctx.snap.lastGoodDetail'), tone: 'warning' };
  }
  if (meta?.stale === true) {
    return { label: t('dctx.snap.stale'), detail: t('dctx.snap.staleDetail'), tone: 'warning' };
  }
  if (meta?.stale === false) {
    return { label: t('dctx.snap.current'), detail: t('dctx.snap.currentDetail'), tone: 'neutral' };
  }
  return { label: t('dctx.snap.unknown'), detail: t('dctx.snap.unknownDetail'), tone: 'neutral' };
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
  useLang();
  const snapshot = dashboardSnapshotCopy({ meta, heldRangeNotice, refreshError });
  const timezone = meta?.query?.timezone || meta?.timezone || null;
  const echoedRange = meta?.query?.range;
  const echoedCustomRange = echoedRange === 'custom' && meta?.query?.start && meta?.query?.end
    ? { start: meta.query.start, end: meta.query.end }
    : null;
  const rangeLabel = echoedRange
    ? rangeDisplayName(echoedRange, echoedCustomRange)
    : rangeDisplayName(range, customRange);
  const rangeCaption = echoedRange ? t('dctx.period') : heldRangeNotice ? t('dctx.selection') : t('dctx.period');
  const rangeValue = !echoedRange && heldRangeNotice ? t('dctx.notUpdated', { range: rangeLabel }) : rangeLabel;
  const lastRefreshedAt = validTimestamp(meta?.lastRefreshedAt);
  const generatedAt = validTimestamp(meta?.generatedAt);
  const dataTimestamp = lastRefreshedAt || generatedAt;
  const operationTimestamp = validTimestamp(refreshCompletedAt);
  const operationDiffers = !!dataTimestamp && !!operationTimestamp
    && new Date(operationTimestamp).getTime() !== new Date(dataTimestamp).getTime();
  const timestampLabel = lastRefreshedAt ? t('dctx.refreshedAt') : generatedAt ? t('dctx.generatedAt') : null;

  const timestampText = dataTimestamp && timestampLabel
    ? `${timestampLabel} ${formatLocalDateTime(dataTimestamp)}`
    : operationTimestamp
      ? t('dctx.uiRefreshedNoData', { time: formatLocalDateTime(operationTimestamp) })
      : t('dctx.noTime');

  // U-102：来源、周期与更新时间顶栏和工具行已显示，常态只留 ⓘ；快照可疑时才露出一个短状态词。
  return (
    <section className={`dashboard-context-bar is-${snapshot.tone}`} aria-label={t('dctx.aria')}>
      {snapshot.tone === 'warning' && !heldRangeNotice && (
        <span className="dashboard-context-flag" title={snapshot.detail}>{snapshot.label}</span>
      )}
      <InfoTip label={t('dctx.info')}>
        <span className="dashboard-context-item">
          {scope === 'cloud' ? <Cloud className="h-3.5 w-3.5" aria-hidden="true" /> : <Database className="h-3.5 w-3.5" aria-hidden="true" />}
          <small>{t('dctx.source')}</small><strong>{dashboardSourceLabel(scope, meta)}</strong>
        </span>
        <span className="dashboard-context-item">
          <CalendarRange className="h-3.5 w-3.5" aria-hidden="true" />
          <small>{rangeCaption}</small><strong>{rangeValue}</strong>
        </span>
        <span className="dashboard-context-item">
          <Globe2 className="h-3.5 w-3.5" aria-hidden="true" />
          <small>{t('dctx.timezone')}</small><strong>{timezone ?? t('dctx.notProvided')}</strong>
        </span>
        <span className="dashboard-context-item">
          <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
          <small>{snapshot.label}</small><strong>{timestampText}</strong>
        </span>
        {snapshot.tone === 'warning' && <span className="dashboard-context-item">{snapshot.detail}</span>}
        {operationDiffers && operationTimestamp && (
          <span className="dashboard-context-item">{t('dctx.uiRefreshed', { time: formatLocalDateTime(operationTimestamp) })}</span>
        )}
      </InfoTip>
    </section>
  );
}

export default DashboardContextBar;
