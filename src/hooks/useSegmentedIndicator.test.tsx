import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { placeSegmentIndicator, useSegmentedIndicator } from './useSegmentedIndicator';

function mockLayout(element: HTMLElement, box: { left: number; top: number; width: number; height: number }, parent: HTMLElement) {
  Object.defineProperty(element, 'offsetLeft', { configurable: true, get: () => box.left });
  Object.defineProperty(element, 'offsetTop', { configurable: true, get: () => box.top });
  Object.defineProperty(element, 'offsetWidth', { configurable: true, get: () => box.width });
  Object.defineProperty(element, 'offsetHeight', { configurable: true, get: () => box.height });
  Object.defineProperty(element, 'offsetParent', { configurable: true, get: () => parent });
}

function Segmented({ initial = 'b' }: { initial?: string }) {
  const [active, setActive] = useState(initial);
  const indicatorRef = useSegmentedIndicator<HTMLDivElement>();
  return (
    <div ref={indicatorRef} className="tl-seg" role="group" aria-label="范围" data-testid="group">
      {['a', 'b', 'c'].map((key) => (
        <button key={key} type="button" aria-pressed={active === key} onClick={() => setActive(key)}>{key}</button>
      ))}
    </div>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('placeSegmentIndicator', () => {
  it('writes the active option box and shows the pill', () => {
    const container = document.createElement('div');
    const first = document.createElement('button');
    const second = document.createElement('button');
    second.setAttribute('aria-pressed', 'true');
    container.append(first, second);
    mockLayout(second, { left: 84, top: 3, width: 62, height: 34 }, container);

    expect(placeSegmentIndicator(container)).toBe(true);
    expect(container.style.getPropertyValue('--seg-x')).toBe('84px');
    expect(container.style.getPropertyValue('--seg-y')).toBe('3px');
    expect(container.style.getPropertyValue('--seg-w')).toBe('62px');
    expect(container.style.getPropertyValue('--seg-h')).toBe('34px');
    expect(container.style.getPropertyValue('--seg-opacity')).toBe('1');
  });

  it('hides the pill when nothing is selected or the option is not laid out', () => {
    const container = document.createElement('div');
    const option = document.createElement('button');
    container.append(option);
    expect(placeSegmentIndicator(container)).toBe(false);
    expect(container.style.getPropertyValue('--seg-opacity')).toBe('0');

    option.setAttribute('aria-current', 'page');
    mockLayout(option, { left: 0, top: 0, width: 0, height: 0 }, container);
    expect(placeSegmentIndicator(container)).toBe(false);
    expect(container.style.getPropertyValue('--seg-opacity')).toBe('0');
  });

  it('prefers a visible sub-entry over its group and falls back to the group when the sub-entry is hidden', () => {
    const selector = '[aria-current="page"], [aria-current="true"]';
    const container = document.createElement('nav');
    const group = document.createElement('button');
    const sub = document.createElement('button');
    group.setAttribute('aria-current', 'true');
    sub.setAttribute('aria-current', 'page');
    container.append(group, sub);
    mockLayout(group, { left: 0, top: 0, width: 180, height: 44 }, container);
    const subBox = { left: 0, top: 88, width: 180, height: 44 };
    mockLayout(sub, subBox, container);

    expect(placeSegmentIndicator(container, selector)).toBe(true);
    expect(container.style.getPropertyValue('--seg-y')).toBe('88px');

    subBox.width = 0;
    expect(placeSegmentIndicator(container, selector)).toBe(true);
    expect(container.style.getPropertyValue('--seg-y')).toBe('0px');
  });
});

describe('useSegmentedIndicator', () => {
  it('follows selection changes and marks the control ready after the first frame', async () => {
    const { getByTestId, getByRole } = render(<Segmented />);
    const group = getByTestId('group');
    const buttons = Array.from(group.querySelectorAll('button'));
    buttons.forEach((button, index) => mockLayout(button, { left: index * 50, top: 2, width: 48, height: 32 }, group));

    // Re-measure with the mocked layout (jsdom has no layout engine).
    await act(async () => {
      getByRole('button', { name: 'c' }).click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(group.style.getPropertyValue('--seg-x')).toBe('100px');
    expect(group.style.getPropertyValue('--seg-opacity')).toBe('1');
    expect(group.hasAttribute('data-seg-ready')).toBe(true);
  });

  it('tears down on unmount', () => {
    const { getByTestId, unmount } = render(<Segmented />);
    const group = getByTestId('group');
    unmount();
    expect(group.hasAttribute('data-seg-ready')).toBe(false);
  });
});
