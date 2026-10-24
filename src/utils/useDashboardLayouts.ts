import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  activeDashboardLayout,
  addLayout,
  defaultDashboardLayoutState,
  deleteLayout,
  moveActiveCard,
  normalizeDashboardLayoutState,
  renameLayout,
  resetActiveLayout,
  setActiveCards,
  setActiveCardVisible,
  setActiveCardWidth,
  switchLayout,
  type DashboardCardId,
  type DashboardCardWidth,
  type DashboardLayoutCard,
  type DashboardLayoutState,
} from './dashboardLayout';
import { DASHBOARD_DISPLAY_PREFERENCES_KEY, normalizeDashboardDisplayPreferences } from './useDashboardDisplayPreferences';

export const DASHBOARD_LAYOUTS_KEY = 'tokenledger:dashboard-layouts:v2';

function readLegacyModules() {
  try {
    const stored = window.localStorage.getItem(DASHBOARD_DISPLAY_PREFERENCES_KEY);
    if (!stored) return null;
    const legacy = normalizeDashboardDisplayPreferences(JSON.parse(stored));
    return { moduleOrder: legacy.moduleOrder, hiddenModuleIds: legacy.hiddenModuleIds };
  } catch {
    return null;
  }
}

function readStoredState(): DashboardLayoutState {
  if (typeof window === 'undefined') return defaultDashboardLayoutState();
  try {
    const stored = window.localStorage.getItem(DASHBOARD_LAYOUTS_KEY);
    if (stored) return normalizeDashboardLayoutState(JSON.parse(stored));
  } catch {
    // 损坏的存储回到默认，概览不能因此打不开。
  }
  return normalizeDashboardLayoutState(null, readLegacyModules());
}

let snapshot: DashboardLayoutState = readStoredState();
const subscribers = new Set<() => void>();
let listenersInstalled = false;

function publish(next: DashboardLayoutState, persist: boolean) {
  snapshot = next;
  if (persist && typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(DASHBOARD_LAYOUTS_KEY, JSON.stringify(next));
    } catch {
      // 受限的 WebView 可能拒绝写入；本次会话里布局照样生效。
    }
  }
  subscribers.forEach(listener => listener());
}

function installListeners() {
  if (listenersInstalled || typeof window === 'undefined') return;
  listenersInstalled = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== DASHBOARD_LAYOUTS_KEY && event.key !== null) return;
    publish(readStoredState(), false);
  });
}

function subscribe(listener: () => void) {
  installListeners();
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

let layoutSeq = 0;
function newLayoutId() {
  layoutSeq += 1;
  return `custom-${Date.now().toString(36)}-${layoutSeq}`;
}

/**
 * 概览页布局（本机、按窗口同步）。`available` 是当前能渲染的卡片：额度详情在额度子页时、
 * 异常检测还没接入时不在里面，移动与「至少留一张」都只按能看到的卡片算。
 */
export function useDashboardLayouts(available?: ReadonlySet<DashboardCardId>) {
  const state = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  const update = useCallback((apply: (current: DashboardLayoutState) => DashboardLayoutState) => {
    const next = apply(snapshot);
    if (next !== snapshot) publish(next, true);
  }, []);
  const layout = activeDashboardLayout(state);
  const actions = useMemo(() => ({
    switchLayout: (id: string) => update(current => switchLayout(current, id)),
    addLayout: (name: string) => update(current => addLayout(current, name, newLayoutId())),
    renameLayout: (id: string, name: string) => update(current => renameLayout(current, id, name)),
    deleteLayout: (id: string) => update(current => deleteLayout(current, id)),
    resetLayout: () => update(resetActiveLayout),
    moveCard: (id: DashboardCardId, targetIndex: number) => update(current => moveActiveCard(current, id, targetIndex, available)),
    setCards: (cards: DashboardLayoutCard[]) => update(current => setActiveCards(current, cards)),
    setCardVisible: (id: DashboardCardId, visible: boolean) => update(current => setActiveCardVisible(current, id, visible, available)),
    setCardWidth: (id: DashboardCardId, width: DashboardCardWidth) => update(current => setActiveCardWidth(current, id, width)),
  }), [update, available]);
  return { state, layout, ...actions };
}

/** 只给测试用：清掉内存里的快照，重新从存储读。 */
export function reloadDashboardLayoutsForTest() {
  publish(readStoredState(), false);
}
