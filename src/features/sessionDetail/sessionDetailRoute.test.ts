import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Tab } from '../../types';
import { isRealSessionId, openSessionDetail, parseSessionDetailHash, sessionDetailHash, useSessionDetailRoute } from './sessionDetailRoute';

describe('会话详情地址', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('编码与解析互逆，工具可缺省', () => {
    const ref = { sessionId: 'a/b c#1', tool: 'claude' };
    expect(parseSessionDetailHash(sessionDetailHash(ref))).toEqual(ref);
    expect(sessionDetailHash({ sessionId: 'x', tool: null })).toBe('#session/-/x');
    expect(parseSessionDetailHash('#session/-/x')).toEqual({ sessionId: 'x', tool: null });
  });

  it('拒绝占位会话与坏地址', () => {
    expect(isRealSessionId('unknown_session')).toBe(false);
    expect(isRealSessionId(' ')).toBe(false);
    expect(parseSessionDetailHash('#session/claude/unknown_session')).toBeNull();
    expect(parseSessionDetailHash('#session/claude')).toBeNull();
    expect(parseSessionDetailHash('#session/%E0%A4%A/x')).toBeNull();
    expect(parseSessionDetailHash('#sessions')).toBeNull();
  });

  it('打开详情时切到会话子页，离开会话子页时收起并清掉锚点', () => {
    const changeTab = vi.fn();
    const { result, rerender } = renderHook(({ tab }: { tab: Tab }) => useSessionDetailRoute(tab, changeTab), { initialProps: { tab: 'dashboard' as Tab } });
    expect(result.current.ref).toBeNull();
    act(() => {
      openSessionDetail({ sessionId: 's-1', tool: 'codex' });
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(changeTab).toHaveBeenCalledWith('behavior');
    expect(result.current.ref).toEqual({ sessionId: 's-1', tool: 'codex' });
    rerender({ tab: 'behavior' });
    rerender({ tab: 'logs' });
    expect(result.current.ref).toBeNull();
    expect(window.location.hash).toBe('');
  });

  it('返回列表时地址回到 #sessions', () => {
    window.history.replaceState(null, '', '#session/claude/s-2');
    const { result } = renderHook(() => useSessionDetailRoute('behavior', vi.fn()));
    expect(result.current.ref).toEqual({ sessionId: 's-2', tool: 'claude' });
    act(() => result.current.close());
    expect(result.current.ref).toBeNull();
    expect(window.location.hash).toBe('#sessions');
  });
});
