import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Tab } from '../../types';
import { useModelAccessRedirect } from './useModelAccessRedirect';

describe('useModelAccessRedirect（U-112）', () => {
  it('关闭时停在模型页就切回用量概览，且不再显示该页', () => {
    const changeTab = vi.fn();
    const { result } = renderHook(() => useModelAccessRedirect('routing', false, changeTab));
    expect(changeTab).toHaveBeenCalledWith('dashboard');
    expect(result.current).toBe(false);
  });

  it('开启或设置未读到时不跳页', () => {
    const changeTab = vi.fn();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean | undefined }) => useModelAccessRedirect('agents', enabled, changeTab),
      { initialProps: { enabled: undefined as boolean | undefined } },
    );
    expect(result.current).toBe(true);
    rerender({ enabled: true });
    expect(result.current).toBe(true);
    expect(changeTab).not.toHaveBeenCalled();
  });

  it('关闭时停在非模型页不受影响', () => {
    const changeTab = vi.fn();
    const pages: Tab[] = ['dashboard', 'settings', 'logs'];
    for (const page of pages) {
      const { result } = renderHook(() => useModelAccessRedirect(page, false, changeTab));
      expect(result.current).toBe(false);
    }
    expect(changeTab).not.toHaveBeenCalled();
  });
});
