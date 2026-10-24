/**
 * 概览页卡片布局：每套布局是一串卡片（顺序、显隐、宽度），可以存多套并一键切换。
 * 这里只放纯数据与变换，读写本机存储在 useDashboardLayouts.ts。
 */

export const DASHBOARD_CARD_IDS = [
  'metrics',
  'quotaHighlights',
  'trend',
  'quota',
  'split',
  'anomaly',
  'budget',
  'insights',
  'context',
  'temporal',
  'heatmap',
  'tools',
] as const;
export type DashboardCardId = typeof DASHBOARD_CARD_IDS[number];

/** 宽度按 6 栏网格计：全宽 6、半宽 3、三分之一 2。窄窗口下一律全宽。 */
export const DASHBOARD_CARD_WIDTHS = ['full', 'half', 'third'] as const;
export type DashboardCardWidth = typeof DASHBOARD_CARD_WIDTHS[number];

export const DASHBOARD_CARD_WIDTH_LABELS: Record<DashboardCardWidth, string> = {
  full: '全宽',
  half: '半宽',
  third: '三分之一',
};

export interface DashboardCardDefinition {
  label: string;
  /** 卡片内容在这些宽度下仍然排得开；第一个是默认宽度。 */
  widths: readonly DashboardCardWidth[];
}

export const DASHBOARD_CARDS: Record<DashboardCardId, DashboardCardDefinition> = {
  // 统计条内部按视口分四栏，放进半宽会挤掉数字，只给全宽。
  metrics: { label: '统计条', widths: ['full'] },
  quotaHighlights: { label: '额度要点', widths: ['full', 'half', 'third'] },
  trend: { label: '趋势', widths: ['full', 'half'] },
  quota: { label: '额度详情', widths: ['full', 'half'] },
  split: { label: '用量拆分', widths: ['full', 'half'] },
  anomaly: { label: '用量异常', widths: ['full', 'half'] },
  budget: { label: '预算', widths: ['full', 'half', 'third'] },
  insights: { label: '消费洞察', widths: ['full', 'half'] },
  context: { label: '平均 Context 构成', widths: ['full', 'half', 'third'] },
  temporal: { label: '时段规律', widths: ['full', 'half'] },
  heatmap: { label: '热力图', widths: ['full'] },
  tools: { label: 'Agent 用量', widths: ['full', 'half'] },
};

export interface DashboardLayoutCard {
  id: DashboardCardId;
  visible: boolean;
  width: DashboardCardWidth;
}

export const DASHBOARD_LAYOUT_PRESETS = ['daily', 'saver'] as const;
export type DashboardLayoutPreset = typeof DASHBOARD_LAYOUT_PRESETS[number];

export interface DashboardLayout {
  id: string;
  name: string;
  /** 「恢复默认」回到哪一套模板；自建布局为 null，回到标准默认。 */
  preset: DashboardLayoutPreset | null;
  cards: DashboardLayoutCard[];
}

export interface DashboardLayoutState {
  version: 2;
  activeId: string;
  layouts: DashboardLayout[];
}

export const MAX_DASHBOARD_LAYOUTS = 6;
export const MAX_DASHBOARD_LAYOUT_NAME = 12;

const PRESET_NAMES: Record<DashboardLayoutPreset, string> = { daily: '日常', saver: '省钱' };

function card(id: DashboardCardId, visible = true, width: DashboardCardWidth = DASHBOARD_CARDS[id].widths[0]): DashboardLayoutCard {
  return { id, visible, width };
}

/** 标准默认：与改版前的概览同序，全部全宽；预算卡片默认收起，在「省钱」里打开。 */
export function defaultDashboardCards(): DashboardLayoutCard[] {
  return DASHBOARD_CARD_IDS.map(id => card(id, id !== 'budget'));
}

export function presetDashboardCards(preset: DashboardLayoutPreset | null): DashboardLayoutCard[] {
  if (preset !== 'saver') return defaultDashboardCards();
  // 省钱：先看花了多少、离预算和额度还有多远，再看钱花在哪些模型和缓存上。
  const shown: DashboardLayoutCard[] = [
    card('metrics'),
    card('budget', true, 'half'),
    card('quotaHighlights', true, 'half'),
    card('insights'),
    card('context', true, 'half'),
    card('anomaly', true, 'half'),
    card('trend'),
  ];
  const hidden = DASHBOARD_CARD_IDS.filter(id => !shown.some(item => item.id === id)).map(id => card(id, false));
  return [...shown, ...hidden];
}

export function presetDashboardLayout(preset: DashboardLayoutPreset): DashboardLayout {
  return { id: preset, name: PRESET_NAMES[preset], preset, cards: presetDashboardCards(preset) };
}

export function defaultDashboardLayoutState(): DashboardLayoutState {
  return { version: 2, activeId: 'daily', layouts: DASHBOARD_LAYOUT_PRESETS.map(presetDashboardLayout) };
}

function isCardId(value: unknown): value is DashboardCardId {
  return typeof value === 'string' && (DASHBOARD_CARD_IDS as readonly string[]).includes(value);
}

function normalizeName(value: unknown, fallback: string): string {
  const name = typeof value === 'string' ? value.trim().slice(0, MAX_DASHBOARD_LAYOUT_NAME) : '';
  return name || fallback;
}

/** 去重、丢掉不认识的卡片、补上新增的卡片（按默认位置插入末尾、默认显示），并保证至少一张可见。 */
export function normalizeDashboardCards(value: unknown, fallback: DashboardLayoutCard[] = defaultDashboardCards()): DashboardLayoutCard[] {
  if (!Array.isArray(value)) return fallback.map(item => ({ ...item }));
  const seen = new Set<DashboardCardId>();
  const cards: DashboardLayoutCard[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const { id, visible, width } = raw as Partial<DashboardLayoutCard>;
    if (!isCardId(id) || seen.has(id)) continue;
    seen.add(id);
    const widths = DASHBOARD_CARDS[id].widths;
    cards.push({ id, visible: visible !== false, width: widths.includes(width as DashboardCardWidth) ? width as DashboardCardWidth : widths[0] });
  }
  for (const item of fallback) if (!seen.has(item.id)) cards.push({ ...item });
  if (!cards.some(item => item.visible)) cards[0] = { ...cards[0], visible: true };
  return cards;
}

/**
 * 读存储里的布局状态。不认识的版本或损坏的数据回到默认；名字重复不合并，只截短。
 * `legacy` 是旧版「调整显示」存的模块顺序与隐藏，只在还没有新版布局时用来生成「日常」。
 */
export function normalizeDashboardLayoutState(value: unknown, legacy?: { moduleOrder: string[]; hiddenModuleIds: string[] } | null): DashboardLayoutState {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 2) {
    const state = defaultDashboardLayoutState();
    if (legacy) state.layouts[0] = { ...state.layouts[0], cards: migrateLegacyModules(legacy) };
    return state;
  }
  const raw = value as Partial<DashboardLayoutState>;
  const seenIds = new Set<string>();
  const layouts: DashboardLayout[] = [];
  for (const item of Array.isArray(raw.layouts) ? raw.layouts : []) {
    if (!item || typeof item !== 'object' || layouts.length >= MAX_DASHBOARD_LAYOUTS) continue;
    const layout = item as Partial<DashboardLayout>;
    if (typeof layout.id !== 'string' || !layout.id || seenIds.has(layout.id)) continue;
    seenIds.add(layout.id);
    const preset = (DASHBOARD_LAYOUT_PRESETS as readonly string[]).includes(layout.preset as string) ? layout.preset as DashboardLayoutPreset : null;
    layouts.push({
      id: layout.id,
      name: normalizeName(layout.name, preset ? PRESET_NAMES[preset] : '布局'),
      preset,
      cards: normalizeDashboardCards(layout.cards, presetDashboardCards(preset)),
    });
  }
  if (!layouts.length) return defaultDashboardLayoutState();
  const activeId = layouts.some(layout => layout.id === raw.activeId) ? raw.activeId as string : layouts[0].id;
  return { version: 2, activeId, layouts };
}

/** 旧版五个大模块 → 新卡片：顺序按模块展开，隐藏的模块下所有卡片都隐藏。 */
export function migrateLegacyModules(legacy: { moduleOrder: string[]; hiddenModuleIds: string[] }): DashboardLayoutCard[] {
  const groups: Record<string, DashboardCardId[]> = {
    kpi: ['metrics', 'quotaHighlights'],
    trend: ['trend'],
    quota: ['quota'],
    distribution: ['split'],
    insights: ['anomaly', 'insights', 'context', 'temporal', 'heatmap', 'tools'],
  };
  const hidden = new Set(legacy.hiddenModuleIds);
  const cards: DashboardLayoutCard[] = [];
  for (const module of legacy.moduleOrder) {
    for (const id of groups[module] ?? []) {
      // 旧版额度要点挂在统计条下，隐藏「订阅额度」时它也一起消失。
      const visible = !hidden.has(module) && !(id === 'quotaHighlights' && hidden.has('quota'));
      cards.push(card(id, visible));
    }
  }
  return normalizeDashboardCards(cards);
}

export function activeDashboardLayout(state: DashboardLayoutState): DashboardLayout {
  return state.layouts.find(layout => layout.id === state.activeId) ?? state.layouts[0];
}

function updateActive(state: DashboardLayoutState, apply: (cards: DashboardLayoutCard[]) => DashboardLayoutCard[]): DashboardLayoutState {
  return {
    ...state,
    layouts: state.layouts.map(layout => layout.id === state.activeId ? { ...layout, cards: normalizeDashboardCards(apply(layout.cards)) } : layout),
  };
}

/** 把一张卡片移到 `available` 里的第 `targetIndex` 位；不可用（当前不渲染）的卡片留在原处不动。 */
export function moveCardTo(cards: readonly DashboardLayoutCard[], id: DashboardCardId, targetIndex: number, available?: ReadonlySet<DashboardCardId>): DashboardLayoutCard[] {
  const isAvailable = (item: DashboardLayoutCard) => !available || available.has(item.id);
  const slots = cards.map((item, index) => isAvailable(item) ? index : -1).filter(index => index >= 0);
  const order = slots.map(index => cards[index]);
  const from = order.findIndex(item => item.id === id);
  if (from < 0) return [...cards];
  const to = Math.max(0, Math.min(order.length - 1, targetIndex));
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  const next = [...cards];
  slots.forEach((slot, index) => { next[slot] = order[index]; });
  return next;
}

export function setActiveCards(state: DashboardLayoutState, cards: DashboardLayoutCard[]): DashboardLayoutState {
  return updateActive(state, () => cards);
}

export function moveActiveCard(state: DashboardLayoutState, id: DashboardCardId, targetIndex: number, available?: ReadonlySet<DashboardCardId>): DashboardLayoutState {
  return updateActive(state, cards => moveCardTo(cards, id, targetIndex, available));
}

/** 隐藏最后一张可见卡片不生效：概览不能变成空白页。 */
export function setActiveCardVisible(state: DashboardLayoutState, id: DashboardCardId, visible: boolean, available?: ReadonlySet<DashboardCardId>): DashboardLayoutState {
  const cards = activeDashboardLayout(state).cards;
  if (!visible && cards.filter(item => item.visible && item.id !== id && (!available || available.has(item.id))).length === 0) return state;
  return updateActive(state, list => list.map(item => item.id === id ? { ...item, visible } : item));
}

export function setActiveCardWidth(state: DashboardLayoutState, id: DashboardCardId, width: DashboardCardWidth): DashboardLayoutState {
  if (!DASHBOARD_CARDS[id].widths.includes(width)) return state;
  return updateActive(state, list => list.map(item => item.id === id ? { ...item, width } : item));
}

export function resetActiveLayout(state: DashboardLayoutState): DashboardLayoutState {
  const layout = activeDashboardLayout(state);
  return updateActive(state, () => presetDashboardCards(layout.preset));
}

export function switchLayout(state: DashboardLayoutState, id: string): DashboardLayoutState {
  return state.layouts.some(layout => layout.id === id) ? { ...state, activeId: id } : state;
}

/** 新布局从当前布局复制一份；名字重复时加序号。满了不新增。 */
export function addLayout(state: DashboardLayoutState, name: string, id: string): DashboardLayoutState {
  if (state.layouts.length >= MAX_DASHBOARD_LAYOUTS) return state;
  const base = normalizeName(name, '新布局');
  const names = new Set(state.layouts.map(layout => layout.name));
  let unique = base;
  for (let index = 2; names.has(unique); index += 1) unique = `${base.slice(0, MAX_DASHBOARD_LAYOUT_NAME - String(index).length - 1)} ${index}`;
  const source = activeDashboardLayout(state);
  return {
    ...state,
    activeId: id,
    layouts: [...state.layouts, { id, name: unique, preset: null, cards: source.cards.map(item => ({ ...item })) }],
  };
}

export function renameLayout(state: DashboardLayoutState, id: string, name: string): DashboardLayoutState {
  const trimmed = name.trim().slice(0, MAX_DASHBOARD_LAYOUT_NAME);
  if (!trimmed) return state;
  return { ...state, layouts: state.layouts.map(layout => layout.id === id ? { ...layout, name: trimmed } : layout) };
}

/** 至少留一套布局；删掉当前布局时切到它前一套。 */
export function deleteLayout(state: DashboardLayoutState, id: string): DashboardLayoutState {
  if (state.layouts.length <= 1) return state;
  const index = state.layouts.findIndex(layout => layout.id === id);
  if (index < 0) return state;
  const layouts = state.layouts.filter(layout => layout.id !== id);
  const activeId = state.activeId === id ? layouts[Math.max(0, index - 1)].id : state.activeId;
  return { ...state, activeId, layouts };
}
