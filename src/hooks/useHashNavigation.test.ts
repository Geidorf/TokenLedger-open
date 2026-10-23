import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_DESTINATIONS } from '../utils/settingsNavigation';
import { directTabFromHash, useHashNavigation } from './useHashNavigation';

function goTo(hash: string) {
  act(() => {
    window.history.replaceState(null, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

afterEach(() => {
  window.history.replaceState(null, '', '#');
});

describe('directTabFromHash', () => {
  it('识别模型接入、用量与已登记设置分区，其他返回 null', () => {
    expect(directTabFromHash('#agents')).toBe('agents');
    expect(directTabFromHash('#providers')).toBe('providers');
    expect(directTabFromHash('#gateway')).toBe('gateway');
    expect(directTabFromHash('#routing')).toBe('routing');
    expect(directTabFromHash('#records')).toBe('logs');
    expect(directTabFromHash('#behavior')).toBe('behavior');
    expect(directTabFromHash('#settings-cloud')).toBe('settings');
    expect(directTabFromHash('#settings-not-registered')).toBeNull();
    expect(directTabFromHash('')).toBeNull();
  });
});

describe('useHashNavigation', () => {
  it('页面打开后改 hash 也会切到模型接入四页（T10.276）', () => {
    const changeTab = vi.fn();
    renderHook(() => useHashNavigation(changeTab));
    for (const tab of ['agents', 'providers', 'gateway', 'routing']) {
      goTo(`#${tab}`);
      expect(changeTab).toHaveBeenLastCalledWith(tab);
    }
    expect(changeTab).toHaveBeenCalledTimes(4);
  });

  it('用量锚点照旧响应，旧设置锚点改写地址后切页，无关锚点不动', () => {
    const changeTab = vi.fn();
    renderHook(() => useHashNavigation(changeTab));
    goTo('#records');
    expect(changeTab).toHaveBeenLastCalledWith('logs');
    goTo('#behavior');
    expect(changeTab).toHaveBeenLastCalledWith('behavior');
    goTo('#settings-api-profiles');
    expect(changeTab).toHaveBeenLastCalledWith('settings');
    expect(window.location.hash).toBe('#settings-model-access');
    changeTab.mockClear();
    goTo('#settings-cloud');
    expect(changeTab).toHaveBeenLastCalledWith('settings');
    changeTab.mockClear();
    goTo('#settings-not-registered');
    expect(changeTab).not.toHaveBeenCalled();
  });

  it('从其他页面跟随每个已登记设置分区，保留目标hash供设置页选择分区', () => {
    const changeTab = vi.fn();
    renderHook(() => useHashNavigation(changeTab));
    for (const destination of SETTINGS_DESTINATIONS) {
      goTo(`#${destination.id}`);
      expect(changeTab).toHaveBeenLastCalledWith('settings');
      expect(window.location.hash).toBe(`#${destination.id}`);
    }
    expect(changeTab).toHaveBeenCalledTimes(SETTINGS_DESTINATIONS.length);
  });

  it('卸载后不再响应', () => {
    const changeTab = vi.fn();
    const { unmount } = renderHook(() => useHashNavigation(changeTab));
    unmount();
    goTo('#gateway');
    expect(changeTab).not.toHaveBeenCalled();
  });
});
