import { useCallback, useRef } from 'react';

/** Options that count as "selected" across the app's segmented controls and navigation. */
export const SEGMENT_ACTIVE_SELECTOR = [
  '[aria-pressed="true"]',
  '[aria-checked="true"]',
  '[aria-selected="true"]',
  '[aria-current="page"]',
  '[data-active="true"]',
].join(', ');

const OBSERVED_ATTRIBUTES = ['aria-pressed', 'aria-checked', 'aria-selected', 'aria-current', 'data-active', 'class', 'hidden'];

type FrameHandle = ReturnType<typeof setTimeout> | number;

function requestFrame(callback: () => void): FrameHandle {
  return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : setTimeout(callback, 16);
}

function cancelFrame(handle: FrameHandle) {
  if (typeof cancelAnimationFrame === 'function' && typeof handle === 'number') cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

/**
 * Writes the active option's box to `--seg-x/--seg-y/--seg-w/--seg-h` on the
 * container and shows the `.tl-seg::before` pill; hides it when nothing is
 * selected. Layout offsets are used when the container is the option's
 * offset parent, so an in-flight scale/translate animation on an ancestor
 * cannot skew the measurement.
 */
export function placeSegmentIndicator(container: HTMLElement, activeSelector = SEGMENT_ACTIVE_SELECTOR) {
  // Several matches mean a group row and its current sub-entry; the last
  // rendered one wins, so a hidden sub-entry hands the pill back to its group.
  let active: HTMLElement | null = null;
  for (const option of Array.from(container.querySelectorAll<HTMLElement>(activeSelector))) {
    if (option.offsetWidth > 0) active = option;
  }
  const style = container.style;
  if (!active) {
    style.setProperty('--seg-opacity', '0');
    return false;
  }
  let x: number;
  let y: number;
  if (active.offsetParent === container) {
    x = active.offsetLeft;
    y = active.offsetTop;
  } else {
    const box = container.getBoundingClientRect();
    const option = active.getBoundingClientRect();
    x = option.left - box.left - container.clientLeft + container.scrollLeft;
    y = option.top - box.top - container.clientTop + container.scrollTop;
  }
  style.setProperty('--seg-x', `${Math.round(x * 100) / 100}px`);
  style.setProperty('--seg-y', `${Math.round(y * 100) / 100}px`);
  style.setProperty('--seg-w', `${active.offsetWidth}px`);
  style.setProperty('--seg-h', `${active.offsetHeight}px`);
  style.setProperty('--seg-opacity', '1');
  return true;
}

/**
 * Keeps the sliding indicator of one container in sync with selection,
 * content and size changes. Returns the teardown function.
 */
export function attachSegmentIndicator(container: HTMLElement, activeSelector = SEGMENT_ACTIVE_SELECTOR): () => void {
  let frame: FrameHandle | null = null;
  const schedule = () => {
    if (frame !== null) cancelFrame(frame);
    frame = requestFrame(() => {
      frame = null;
      placeSegmentIndicator(container, activeSelector);
    });
  };

  placeSegmentIndicator(container, activeSelector);
  // Mark ready one frame later: the first placement must not slide in from 0,0.
  const readyFrame = requestFrame(() => container.setAttribute('data-seg-ready', ''));

  // Our own writes only touch `style` / `data-seg-ready`, which are not observed.
  const mutations = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null;
  mutations?.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: OBSERVED_ATTRIBUTES });
  const resizes = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  resizes?.observe(container);
  if (typeof window !== 'undefined') window.addEventListener('resize', schedule);
  if (typeof document !== 'undefined') void document.fonts?.ready?.then(schedule).catch(() => undefined);

  return () => {
    if (frame !== null) cancelFrame(frame);
    cancelFrame(readyFrame);
    mutations?.disconnect();
    resizes?.disconnect();
    if (typeof window !== 'undefined') window.removeEventListener('resize', schedule);
    container.removeAttribute('data-seg-ready');
  };
}

/**
 * Callback ref for a segmented control or navigation list that renders the
 * shared sliding selection pill. Add the `tl-seg` class to the same element.
 *
 *   const indicatorRef = useSegmentedIndicator<HTMLDivElement>();
 *   <div ref={indicatorRef} className="segmented tl-seg" role="group">…</div>
 */
export function useSegmentedIndicator<T extends HTMLElement = HTMLElement>(activeSelector: string = SEGMENT_ACTIVE_SELECTOR) {
  const teardown = useRef<(() => void) | null>(null);
  return useCallback((node: T | null) => {
    teardown.current?.();
    teardown.current = node ? attachSegmentIndicator(node, activeSelector) : null;
  }, [activeSelector]);
}
