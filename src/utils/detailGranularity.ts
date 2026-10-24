import type { LogHistoryItem, UsageDetailsResponse } from '../types';
import { t } from '../i18n';

type DetailGranularityItem = Pick<LogHistoryItem, 'granularity' | 'requests'>;
type DetailGranularitySource = Pick<UsageDetailsResponse, 'granularity'> & { items: DetailGranularityItem[] };

export function detailGranularityLabel(details: DetailGranularitySource | null | undefined): string {
  if (!details) return t('granularity.loading');
  if (details.granularity === 'hour') return t('granularity.cloudHour');
  return details.items.some((item) => (item.requests ?? 1) > 1) ? t('granularity.logAggregate') : t('granularity.perRequest');
}

export function rowGranularityLabel(log: Pick<LogHistoryItem, 'granularity' | 'requests'>, details: Pick<UsageDetailsResponse, 'granularity'>): string {
  return detailGranularityLabel({
    granularity: log.granularity ?? details.granularity,
    items: [log],
  });
}
