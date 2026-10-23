import type { QuotaProviderEnvelope, QuotaSyncStatus } from '../../types';
import { useDashboardDisplayPreferences } from '../../utils/useDashboardDisplayPreferences';
import { QuotaPanel } from '../QuotaPanel';

export interface UsageAllowancesViewProps {
  providers: QuotaProviderEnvelope[];
  loading: boolean;
  error: string;
  quotaSyncStatus: QuotaSyncStatus;
  onRefresh: () => void;
  onSyncNow: () => void;
  onOpenSettings: () => void;
  onNotify: (message: string) => void;
}

/**
 * 用量 · 额度：订阅额度的完整详情（窗口、重置时间与 Pace）。概览只留额度要点，点开来到这里。
 * 来源顺序与隐藏沿用概览「调整显示」里的设置，两处看到的是同一组来源。
 */
export function UsageAllowancesView(props: UsageAllowancesViewProps) {
  const { preferences } = useDashboardDisplayPreferences();
  return (
    <div className="content-stack usage-allowances">
      <QuotaPanel
        {...props}
        sourceOrder={preferences.quotaSourceOrder}
        hiddenSourceIds={preferences.hiddenQuotaSourceIds}
      />
    </div>
  );
}
