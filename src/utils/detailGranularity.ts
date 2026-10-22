import type { LogHistoryItem, UsageDetailsResponse } from '../types';

type DetailGranularityItem = Pick<LogHistoryItem, 'granularity' | 'requests'>;
type DetailGranularitySource = Pick<UsageDetailsResponse, 'granularity'> & { items: DetailGranularityItem[] };

export function detailGranularityLabel(details: DetailGranularitySource | null | undefined): string {
  if (!details) return '读取中';
  if (details.granularity === 'hour') return '云端小时聚合';
  return details.items.some((item) => (item.requests ?? 1) > 1) ? '日志聚合' : '逐次请求';
}

export function rowGranularityLabel(log: Pick<LogHistoryItem, 'granularity' | 'requests'>, details: Pick<UsageDetailsResponse, 'granularity'>): string {
  return detailGranularityLabel({
    granularity: log.granularity ?? details.granularity,
    items: [log],
  });
}
