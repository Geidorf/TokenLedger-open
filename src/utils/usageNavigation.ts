import type { UsageSub } from '../components/usage/UsagePage';
import type { Tab } from '../types';

/** 用量页子标签与侧栏二级入口共用的 子页 → Tab 映射。 */
export const USAGE_SUB_TABS: Record<UsageSub, Tab> = { overview: 'dashboard', records: 'records', sessions: 'behavior' };

/**
 * 「用量」三个子页可直达的 hash 锚点。合并前的「行为分析」「总览看板」地址
 * （`#behavior`、`#dashboard`）必须继续可用（U-100）。
 */
const USAGE_HASH_TABS: Record<string, Tab> = {
  dashboard: 'dashboard',
  overview: 'dashboard',
  usage: 'dashboard',
  records: 'records',
  'usage-records': 'records',
  behavior: 'behavior',
  'behavior-analysis': 'behavior',
  sessions: 'behavior',
  'usage-sessions': 'behavior',
};

export function usageTabFromHash(hash: string | null | undefined): Tab | null {
  const key = (hash ?? '').replace(/^#/, '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(USAGE_HASH_TABS, key) ? USAGE_HASH_TABS[key] : null;
}
