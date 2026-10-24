import type { UsageSub } from '../components/usage/UsagePage';
import type { Tab } from '../types';

/** 用量页子页与侧栏二级入口共用的 子页 → Tab 映射。 */
export const USAGE_SUB_TABS: Record<UsageSub, Tab> = { overview: 'dashboard', requests: 'logs', sessions: 'behavior', allowances: 'allowances', reports: 'reports' };

/**
 * 「用量」子页可直达的 hash 锚点。合并前的地址必须继续可用：
 * `#behavior`、`#dashboard`（U-100），以及「记录」「活动明细」合并进「请求」前的 `#records`、`#logs`。
 */
const USAGE_HASH_TABS: Record<string, Tab> = {
  dashboard: 'dashboard',
  overview: 'dashboard',
  usage: 'dashboard',
  requests: 'logs',
  'usage-requests': 'logs',
  records: 'logs',
  'usage-records': 'logs',
  logs: 'logs',
  details: 'logs',
  behavior: 'behavior',
  'behavior-analysis': 'behavior',
  sessions: 'behavior',
  'usage-sessions': 'behavior',
  allowances: 'allowances',
  'usage-allowances': 'allowances',
  quota: 'allowances',
  quotas: 'allowances',
  reports: 'reports',
  report: 'reports',
  'usage-reports': 'reports',
  weekly: 'reports',
  monthly: 'reports',
};

export function usageTabFromHash(hash: string | null | undefined): Tab | null {
  const key = (hash ?? '').replace(/^#/, '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(USAGE_HASH_TABS, key) ? USAGE_HASH_TABS[key] : null;
}
