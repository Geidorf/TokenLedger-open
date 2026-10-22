import { useEffect } from 'react';
import { MODEL_TABS, type ModelTab, type Tab } from '../types';
import { legacySettingsRedirect, SETTINGS_DESTINATIONS } from '../utils/settingsNavigation';
import { usageTabFromHash } from '../utils/usageNavigation';

/** 可直达的一级页锚点：用量子页、模型接入四页与已登记设置分区。 */
export function directTabFromHash(hash: string | null | undefined): Tab | null {
  const key = (hash ?? '').replace(/^#/, '').trim().toLowerCase();
  if ((MODEL_TABS as readonly string[]).includes(key)) return key as ModelTab;
  if (SETTINGS_DESTINATIONS.some(destination => destination.id === key)) return 'settings';
  return usageTabFromHash(key);
}

/** 页面打开后再改 hash 也要跳转：直达锚点切页，旧设置锚点改写为新地址后切页。 */
export function useHashNavigation(changeTab: (tab: Tab) => void) {
  useEffect(() => {
    const followHash = () => {
      const direct = directTabFromHash(window.location.hash);
      if (direct) {
        changeTab(direct);
        return;
      }
      const redirect = legacySettingsRedirect(window.location.hash);
      if (!redirect) return;
      window.history.replaceState(null, '', `#${redirect}`);
      changeTab('settings');
    };
    window.addEventListener('hashchange', followHash);
    return () => window.removeEventListener('hashchange', followHash);
  }, [changeTab]);
}
