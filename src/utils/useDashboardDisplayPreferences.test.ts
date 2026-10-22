import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DASHBOARD_DISPLAY_PREFERENCES_KEY, normalizeDashboardDisplayPreferences, orderQuotaSourceKeys, useDashboardDisplayPreferences } from './useDashboardDisplayPreferences';

afterEach(() => window.localStorage.clear());

describe('dashboard display preferences', () => {
  it('deduplicates stored modules, drops the former analytics card, and appends current defaults', () => {
    const value = normalizeDashboardDisplayPreferences({
      version: 1,
      moduleOrder: ['quota', 'quota', 'analytics', 'unknown'],
      hiddenModuleIds: ['quota', 'analytics', 'unknown'],
      quotaSourceOrder: ['codex:consumer', 'codex:consumer'],
    });
    expect(value.moduleOrder).toEqual(['quota', 'kpi', 'trend', 'distribution', 'insights']);
    expect(value.hiddenModuleIds).toEqual(['quota']);
    expect(value.quotaSourceOrder).toEqual(['codex:consumer']);
  });

  it('keeps absent sources in storage while appending newly available sources for rendering', () => {
    const preferences = normalizeDashboardDisplayPreferences({ quotaSourceOrder: ['missing:subscription', 'codex:consumer'] });
    expect(orderQuotaSourceKeys(['claude:consumer', 'codex:consumer'], preferences)).toEqual(['codex:consumer', 'claude:consumer']);
    expect(preferences.quotaSourceOrder).toEqual(['missing:subscription', 'codex:consumer']);
  });

  it('moves active sources without dropping temporarily absent source IDs', () => {
    const { result } = renderHook(() => useDashboardDisplayPreferences());
    act(() => result.current.moveQuotaSource('codex:consumer', 1, ['codex:consumer', 'claude:consumer']));
    act(() => result.current.moveQuotaSource('claude:consumer', -1, ['codex:consumer', 'claude:consumer', 'missing:consumer']));
    act(() => result.current.moveQuotaSource('codex:consumer', 1, ['codex:consumer', 'claude:consumer']));
    expect(result.current.preferences.quotaSourceOrder).toContain('missing:consumer');
  });

  it('never accepts a stored state that hides all dashboard modules', () => {
    const value = normalizeDashboardDisplayPreferences({
      moduleOrder: ['kpi', 'trend', 'quota', 'distribution', 'insights', 'analytics'],
      hiddenModuleIds: ['kpi', 'trend', 'quota', 'distribution', 'insights', 'analytics'],
    });
    expect(value.hiddenModuleIds).toHaveLength(4);
    expect(value.moduleOrder.some(id => !value.hiddenModuleIds.includes(id))).toBe(true);
  });

  it('rejects an unknown storage version', () => {
    expect(normalizeDashboardDisplayPreferences({ version: 2, moduleOrder: ['quota'] }).moduleOrder).toEqual(['kpi', 'trend', 'quota', 'distribution', 'insights']);
  });

  it('persists, resets, and applies cross-window storage clearing', () => {
    const { result } = renderHook(() => useDashboardDisplayPreferences());
    act(() => result.current.moveModule('trend', -1));
    expect(JSON.parse(window.localStorage.getItem(DASHBOARD_DISPLAY_PREFERENCES_KEY)!)).toMatchObject({ moduleOrder: expect.arrayContaining(['trend', 'kpi']) });
    act(() => result.current.reset());
    expect(window.localStorage.getItem(DASHBOARD_DISPLAY_PREFERENCES_KEY)).toBeNull();
    window.localStorage.setItem(DASHBOARD_DISPLAY_PREFERENCES_KEY, JSON.stringify({ version: 1, moduleOrder: ['quota'] }));
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: DASHBOARD_DISPLAY_PREFERENCES_KEY, storageArea: window.localStorage })));
    expect(result.current.preferences.moduleOrder[0]).toBe('quota');
    window.localStorage.clear();
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: window.localStorage })));
    expect(result.current.preferences.moduleOrder[0]).toBe('kpi');
  });

  it('continues to update the live snapshot when storage rejects writes', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      const { result } = renderHook(() => useDashboardDisplayPreferences());
      act(() => result.current.moveModule('trend', -1));
      expect(result.current.preferences.moduleOrder.slice(0, 2)).toEqual(['trend', 'kpi']);
    } finally { spy.mockRestore(); }
  });
});
