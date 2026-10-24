import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_CARD_IDS,
  MAX_DASHBOARD_LAYOUTS,
  activeDashboardLayout,
  addLayout,
  defaultDashboardLayoutState,
  deleteLayout,
  migrateLegacyModules,
  moveActiveCard,
  moveCardTo,
  normalizeDashboardLayoutState,
  renameLayout,
  resetActiveLayout,
  setActiveCardVisible,
  setActiveCardWidth,
  switchLayout,
  type DashboardCardId,
} from './dashboardLayout';

const ids = (state: ReturnType<typeof defaultDashboardLayoutState>) => activeDashboardLayout(state).cards.map(card => card.id);

describe('dashboard layout model', () => {
  it('starts with the daily and saver layouts; daily keeps the previous overview order', () => {
    const state = defaultDashboardLayoutState();
    expect(state.layouts.map(layout => layout.name)).toEqual(['日常', '省钱']);
    expect(ids(state)).toEqual([...DASHBOARD_CARD_IDS]);
    expect(activeDashboardLayout(state).cards.find(card => card.id === 'budget')?.visible).toBe(false);
    const saver = activeDashboardLayout(switchLayout(state, 'saver'));
    expect(saver.cards.filter(card => card.visible).map(card => card.id).slice(0, 3)).toEqual(['metrics', 'budget', 'quotaHighlights']);
  });

  it('normalizes stored layouts: drops unknown cards, fixes widths, appends new cards, keeps one visible', () => {
    const state = normalizeDashboardLayoutState({
      version: 2,
      activeId: 'missing',
      layouts: [
        { id: 'a', name: '  这个名字非常非常非常非常长  ', preset: 'nope', cards: [
          { id: 'trend', visible: false, width: 'third' },
          { id: 'trend', visible: true },
          { id: 'ghost', visible: true },
          { id: 'heatmap', visible: false, width: 'half' },
        ] },
        { id: 'a', name: 'dup' },
      ],
    });
    expect(state.layouts).toHaveLength(1);
    expect(state.activeId).toBe('a');
    const layout = activeDashboardLayout(state);
    expect(layout.name).toHaveLength(12);
    expect(layout.preset).toBeNull();
    expect(layout.cards[0]).toEqual({ id: 'trend', visible: false, width: 'full' });
    expect(layout.cards[1]).toEqual({ id: 'heatmap', visible: false, width: 'full' });
    expect(layout.cards).toHaveLength(DASHBOARD_CARD_IDS.length);
    expect(layout.cards.some(card => card.visible)).toBe(true);
  });

  it('rejects unknown versions and migrates the old five-module preference', () => {
    const legacy = { moduleOrder: ['insights', 'kpi', 'trend', 'quota', 'distribution'], hiddenModuleIds: ['quota'] };
    const state = normalizeDashboardLayoutState({ version: 9 }, legacy);
    const cards = activeDashboardLayout(state).cards;
    expect(cards.slice(0, 3).map(card => card.id)).toEqual(['anomaly', 'insights', 'context']);
    expect(cards.find(card => card.id === 'quota')?.visible).toBe(false);
    // 旧版额度要点跟着「订阅额度」一起隐藏。
    expect(cards.find(card => card.id === 'quotaHighlights')?.visible).toBe(false);
    expect(cards.find(card => card.id === 'budget')).toBeDefined();
    expect(migrateLegacyModules({ moduleOrder: [], hiddenModuleIds: [] })).toHaveLength(DASHBOARD_CARD_IDS.length);
  });

  it('moves cards among the available ones and leaves unavailable cards in place', () => {
    const state = defaultDashboardLayoutState();
    const available = new Set<DashboardCardId>(DASHBOARD_CARD_IDS.filter(id => id !== 'quota' && id !== 'anomaly'));
    const moved = moveActiveCard(state, 'split', 0, available);
    const order = ids(moved);
    expect(order[0]).toBe('split');
    expect(order.indexOf('quota')).toBe(DASHBOARD_CARD_IDS.indexOf('quota'));
    expect(order.indexOf('anomaly')).toBe(DASHBOARD_CARD_IDS.indexOf('anomaly'));
    const toEnd = moveCardTo(activeDashboardLayout(state).cards, 'metrics', 99);
    expect(toEnd[toEnd.length - 1].id).toBe('metrics');
  });

  it('never hides the last visible card and only accepts widths the card supports', () => {
    let state = defaultDashboardLayoutState();
    const available = new Set<DashboardCardId>(['metrics', 'trend']);
    state = setActiveCardVisible(state, 'trend', false, available);
    expect(setActiveCardVisible(state, 'metrics', false, available)).toBe(state);
    expect(setActiveCardWidth(state, 'heatmap', 'half')).toBe(state);
    const widened = setActiveCardWidth(state, 'context', 'third');
    expect(activeDashboardLayout(widened).cards.find(card => card.id === 'context')?.width).toBe('third');
  });

  it('adds, renames, switches, resets and deletes layouts', () => {
    let state = defaultDashboardLayoutState();
    state = setActiveCardWidth(state, 'trend', 'half');
    state = addLayout(state, '日常', 'c1');
    expect(state.activeId).toBe('c1');
    expect(activeDashboardLayout(state).name).toBe('日常 2');
    expect(activeDashboardLayout(state).cards.find(card => card.id === 'trend')?.width).toBe('half');
    state = renameLayout(state, 'c1', '  周会  ');
    expect(activeDashboardLayout(state).name).toBe('周会');
    expect(renameLayout(state, 'c1', '   ')).toBe(state);
    state = resetActiveLayout(state);
    expect(activeDashboardLayout(state).cards.find(card => card.id === 'trend')?.width).toBe('full');
    // 删掉当前布局后切到前一套；最后一套不能删。
    state = deleteLayout(state, 'c1');
    expect(state.activeId).toBe('saver');
    state = deleteLayout(deleteLayout(state, 'saver'), 'daily');
    expect(state.layouts).toHaveLength(1);
    let full = defaultDashboardLayoutState();
    for (let index = 0; index < MAX_DASHBOARD_LAYOUTS + 2; index += 1) full = addLayout(full, '新', `n${index}`);
    expect(full.layouts).toHaveLength(MAX_DASHBOARD_LAYOUTS);
  });

  it('resets a preset layout to its own template', () => {
    let state = switchLayout(defaultDashboardLayoutState(), 'saver');
    state = setActiveCardVisible(state, 'budget', false);
    state = resetActiveLayout(state);
    expect(activeDashboardLayout(state).cards.find(card => card.id === 'budget')?.visible).toBe(true);
  });
});
