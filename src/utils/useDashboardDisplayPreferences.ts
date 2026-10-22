import { useCallback, useSyncExternalStore } from 'react';

export const DASHBOARD_MODULE_IDS = ['kpi', 'trend', 'quota', 'distribution', 'insights'] as const;
export type DashboardModuleId = typeof DASHBOARD_MODULE_IDS[number];

export interface DashboardDisplayPreferences {
  version: 1;
  moduleOrder: DashboardModuleId[];
  hiddenModuleIds: DashboardModuleId[];
  quotaSourceOrder: string[];
  hiddenQuotaSourceIds: string[];
}

export const DASHBOARD_DISPLAY_PREFERENCES_KEY = 'tokenledger:dashboard-display-preferences:v1';

const DEFAULT_PREFERENCES: DashboardDisplayPreferences = {
  version: 1,
  moduleOrder: [...DASHBOARD_MODULE_IDS],
  hiddenModuleIds: [],
  quotaSourceOrder: [],
  hiddenQuotaSourceIds: [],
};

let snapshot: DashboardDisplayPreferences = readStoredPreferences();
const subscribers = new Set<() => void>();
let listenersInstalled = false;

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))];
}

export function normalizeDashboardDisplayPreferences(value: unknown): DashboardDisplayPreferences {
  if (!value || typeof value !== 'object') return { ...DEFAULT_PREFERENCES, moduleOrder: [...DASHBOARD_MODULE_IDS] };
  const raw = value as Partial<DashboardDisplayPreferences>;
  if (raw.version !== undefined && raw.version !== 1) return { ...DEFAULT_PREFERENCES, moduleOrder: [...DASHBOARD_MODULE_IDS] };
  const requestedOrder = uniqueStrings(raw.moduleOrder).filter((id): id is DashboardModuleId =>
    (DASHBOARD_MODULE_IDS as readonly string[]).includes(id),
  );
  const moduleOrder = [...requestedOrder, ...DASHBOARD_MODULE_IDS.filter(id => !requestedOrder.includes(id))];
  const hiddenModuleIds = uniqueStrings(raw.hiddenModuleIds).filter((id): id is DashboardModuleId => moduleOrder.includes(id as DashboardModuleId));
  // A corrupt/old preference must not make the whole dashboard unrecoverable.
  if (hiddenModuleIds.length === moduleOrder.length) hiddenModuleIds.pop();
  return {
    version: 1,
    moduleOrder,
    hiddenModuleIds,
    quotaSourceOrder: uniqueStrings(raw.quotaSourceOrder),
    hiddenQuotaSourceIds: uniqueStrings(raw.hiddenQuotaSourceIds),
  };
}

function readStoredPreferences(): DashboardDisplayPreferences {
  if (typeof window === 'undefined') return { ...DEFAULT_PREFERENCES, moduleOrder: [...DASHBOARD_MODULE_IDS] };
  try {
    const stored = window.localStorage.getItem(DASHBOARD_DISPLAY_PREFERENCES_KEY);
    return stored ? normalizeDashboardDisplayPreferences(JSON.parse(stored)) : { ...DEFAULT_PREFERENCES, moduleOrder: [...DASHBOARD_MODULE_IDS] };
  } catch {
    return { ...DEFAULT_PREFERENCES, moduleOrder: [...DASHBOARD_MODULE_IDS] };
  }
}

function publish(next: DashboardDisplayPreferences, persist: boolean) {
  snapshot = next;
  if (persist && typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(DASHBOARD_DISPLAY_PREFERENCES_KEY, JSON.stringify(next));
    } catch {
      // A restricted WebView may reject storage. The current session still works.
    }
  }
  subscribers.forEach(listener => listener());
}

function installListeners() {
  if (listenersInstalled || typeof window === 'undefined') return;
  listenersInstalled = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== DASHBOARD_DISPLAY_PREFERENCES_KEY && event.key !== null) return;
    publish(readStoredPreferences(), false);
  });
}

function subscribe(listener: () => void) {
  installListeners();
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function moveItem(items: readonly string[], item: string, direction: -1 | 1): string[] {
  const index = items.indexOf(item);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= items.length) return [...items];
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function quotaSourceKey(provider: { providerId: string; scope: string }) {
  return `${provider.providerId}:${provider.scope}`;
}

export function orderQuotaSourceKeys(sourceKeys: readonly string[], preferences: Pick<DashboardDisplayPreferences, 'quotaSourceOrder' | 'hiddenQuotaSourceIds'>): string[] {
  const known = uniqueStrings(sourceKeys);
  const ordered = preferences.quotaSourceOrder.filter(key => known.includes(key));
  return [...ordered, ...known.filter(key => !ordered.includes(key))];
}

export function effectiveVisibleQuotaSourceKeys(sourceKeys: readonly string[], preferences: Pick<DashboardDisplayPreferences, 'quotaSourceOrder' | 'hiddenQuotaSourceIds'>): string[] {
  const ordered = orderQuotaSourceKeys(sourceKeys, preferences);
  const visible = ordered.filter(key => !preferences.hiddenQuotaSourceIds.includes(key));
  return visible.length > 0 || ordered.length === 0 ? visible : ordered.slice(0, 1);
}

export function useDashboardDisplayPreferences() {
  const preferences = useSyncExternalStore(subscribe, () => snapshot, () => DEFAULT_PREFERENCES);
  const update = useCallback((apply: (current: DashboardDisplayPreferences) => DashboardDisplayPreferences) => {
    publish(normalizeDashboardDisplayPreferences(apply(snapshot)), true);
  }, []);
  const reset = useCallback(() => {
    if (typeof window !== 'undefined') {
      try { window.localStorage.removeItem(DASHBOARD_DISPLAY_PREFERENCES_KEY); } catch { /* session reset still applies */ }
    }
    publish({ ...DEFAULT_PREFERENCES, moduleOrder: [...DASHBOARD_MODULE_IDS] }, false);
  }, []);
  return {
    preferences,
    reset,
    moveModule: (id: DashboardModuleId, direction: -1 | 1) => update(current => ({ ...current, moduleOrder: moveItem(current.moduleOrder, id, direction) as DashboardModuleId[] })),
    setModuleVisible: (id: DashboardModuleId, visible: boolean) => update(current => {
      const hidden = current.hiddenModuleIds.filter(item => item !== id);
      if (!visible && current.moduleOrder.filter(item => !hidden.includes(item)).length > 1) hidden.push(id);
      return { ...current, hiddenModuleIds: hidden };
    }),
    moveQuotaSource: (id: string, direction: -1 | 1, sourceKeys: readonly string[]) => update(current => {
      const activeKeys = uniqueStrings(sourceKeys);
      const movedActive = moveItem(orderQuotaSourceKeys(activeKeys, current), id, direction);
      const pending = [...movedActive];
      const preserved = current.quotaSourceOrder.map(key => activeKeys.includes(key) ? pending.shift()! : key);
      return { ...current, quotaSourceOrder: [...preserved, ...pending] };
    }),
    setQuotaSourceVisible: (id: string, visible: boolean, sourceKeys: readonly string[]) => update(current => {
      const hidden = current.hiddenQuotaSourceIds.filter(item => item !== id);
      const visibleKeys = orderQuotaSourceKeys(sourceKeys, current).filter(item => !hidden.includes(item));
      if (!visible && visibleKeys.length > 1) hidden.push(id);
      return { ...current, hiddenQuotaSourceIds: hidden };
    }),
  };
}
