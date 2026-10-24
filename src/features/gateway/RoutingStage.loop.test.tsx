import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loopFrame, RoutingStage } from './RoutingStage';
import { buildRoutingScene } from './routingScene';

const NOW = Date.parse('2026-10-23T14:00:00Z');

const inflightScene = () => buildRoutingScene({
  now: NOW,
  external: { reachable: true, active: [{ id: 'm1', agent: 'claude', model: 'sonnet', provider: 'anthropic', ms: 300, phase: 'upstream' }] },
});

function mockReducedMotion(reduce: boolean) {
  const listeners = new Set<() => void>();
  const state = { matches: reduce };
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return state.matches && query.includes('reduce'); },
    media: query,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  return {
    set(next: boolean) {
      state.matches = next;
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

describe('RoutingStage 循环效果时钟', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('loopFrame：虚线每步正好挪一个单位，脉冲与外圈在设计范围内', () => {
    expect(loopFrame(0)['--rs-dash']).toBe('0');
    expect(loopFrame(0.7 / 8)['--rs-dash']).toBe('-1');
    expect(loopFrame(0.69)['--rs-dash']).toBe('-7');
    expect(Number(loopFrame(0)['--rs-pulse'])).toBe(1);
    expect(Number(loopFrame(0.6)['--rs-pulse'])).toBeCloseTo(0.35, 2);
    expect(Number(loopFrame(0)['--rs-ring-width'])).toBe(1.5);
    expect(Number(loopFrame(1.7)['--rs-ring-width'])).toBe(7);
    expect(Number(loopFrame(1.7)['--rs-ring-opacity'])).toBe(0.15);
  });

  it('在途请求：一个定时器约每秒 12 次推进各循环元素，卸载后停止', () => {
    mockReducedMotion(false);
    const { container, unmount } = render(<RoutingStage scene={inflightScene()} />);
    const wire = container.querySelector<SVGPathElement>('.rs-wire.is-live')!;
    const held = container.querySelector<SVGCircleElement>('.rs-held')!;
    const ring = container.querySelector<SVGCircleElement>('.rs-hub.is-busy circle')!;
    expect(wire.style.getPropertyValue('--rs-dash')).toBe('0');
    act(() => { vi.advanceTimersByTime(1000 / 12 * 3 + 1); });
    // 第三次推进在约 0.25 秒处。
    expect(wire.style.getPropertyValue('--rs-dash')).toBe('-2');
    expect(Number(held.style.getPropertyValue('--rs-pulse'))).toBeCloseTo(Number(loopFrame(0.25)['--rs-pulse']), 1);
    expect(Number(ring.style.getPropertyValue('--rs-ring-width'))).toBeCloseTo(Number(loopFrame(0.25)['--rs-ring-width']), 1);
    // 静止的线不参与。
    for (const idle of container.querySelectorAll<SVGPathElement>('.rs-wire:not(.is-live)')) expect(idle.style.getPropertyValue('--rs-dash')).toBe('');
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('偏好减少动态效果时不启动时钟，保持静止画面', () => {
    mockReducedMotion(true);
    const { container } = render(<RoutingStage scene={inflightScene()} />);
    expect(vi.getTimerCount()).toBe(0);
    expect(container.querySelector<SVGPathElement>('.rs-wire.is-live')!.style.getPropertyValue('--rs-dash')).toBe('');
  });

  it('挂载期间打开「减少动态效果」立即停下并回到静止画面，关掉后恢复', () => {
    const preference = mockReducedMotion(false);
    const { container, unmount } = render(<RoutingStage scene={inflightScene()} />);
    const wire = container.querySelector<SVGPathElement>('.rs-wire.is-live')!;
    act(() => { vi.advanceTimersByTime(200); });
    expect(wire.style.getPropertyValue('--rs-dash')).not.toBe('');
    act(() => preference.set(true));
    expect(vi.getTimerCount()).toBe(0);
    expect(wire.style.getPropertyValue('--rs-dash')).toBe('');
    act(() => preference.set(false));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(preference.listeners.size).toBe(0);
  });

  it('没有在途或进行中的请求时不启动时钟', () => {
    mockReducedMotion(false);
    render(<RoutingStage scene={buildRoutingScene({ now: NOW, gateway: { running: true, decisions: [], requests: [] } })} />);
    expect(vi.getTimerCount()).toBe(0);
  });
});
