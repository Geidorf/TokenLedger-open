import { useEffect } from 'react';
import { isModelTab, type Tab } from '../../types';

/**
 * 模型接入关闭（U-112）时，停在 Agent、供应商、网关、路由任一页就切回用量概览。
 * `enabled` 为 undefined 表示设置还没读到，不跳页。返回当前模型页是否可见。
 */
export function useModelAccessRedirect(activeTab: Tab, enabled: boolean | undefined, changeTab: (tab: Tab) => void): boolean {
  const parkedOnHiddenPage = enabled === false && isModelTab(activeTab);
  useEffect(() => {
    if (parkedOnHiddenPage) changeTab('dashboard');
  }, [changeTab, parkedOnHiddenPage]);
  return isModelTab(activeTab) && !parkedOnHiddenPage;
}
