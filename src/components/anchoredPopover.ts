import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

export const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function focusAfterPopoverTrigger(trigger: HTMLElement) {
  const focusable = [...document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) => (
    element.tabIndex >= 0
    && element.getAttribute('aria-hidden') !== 'true'
    && !element.closest('[data-header-popover]')
  ));
  const triggerIndex = focusable.indexOf(trigger);
  if (triggerIndex < 0) {
    trigger.focus();
    return;
  }
  (focusable[triggerIndex + 1] ?? trigger).focus();
}

type AnchoredPopoverStyle = Pick<CSSProperties, 'left' | 'maxHeight' | 'top'>;

function measureAnchoredPopover(
  anchor: HTMLElement,
  popover: HTMLElement,
  gap: number,
  fallbackWidth: number,
): AnchoredPopoverStyle {
  const edge = 8;
  const anchorRect = anchor.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const viewportWidth = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
  const viewportHeight = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
  // Layout size first: the tl-pop-in entrance scales the painted box to 97%
  // on its first frame, which is exactly when this measurement runs.
  const width = popover.offsetWidth || popoverRect.width || Math.min(fallbackWidth, viewportWidth - edge * 2);
  const height = popover.offsetHeight || popoverRect.height;
  const left = Math.min(
    Math.max(edge, anchorRect.right - width),
    Math.max(edge, viewportWidth - edge - width),
  );
  const below = anchorRect.bottom + gap;
  const above = anchorRect.top - height - gap;
  const top = below + height <= viewportHeight - edge || above < edge
    ? Math.max(edge, Math.min(below, viewportHeight - edge - height))
    : above;
  return {
    left: Math.round(left),
    maxHeight: Math.max(120, viewportHeight - edge * 2),
    top: Math.round(top),
  };
}

export function useAnchoredPopover(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  popoverRef: RefObject<HTMLElement | null>,
  gap: number,
  fallbackWidth: number,
): AnchoredPopoverStyle | undefined {
  const [style, setStyle] = useState<AnchoredPopoverStyle>();

  useLayoutEffect(() => {
    if (!open) {
      setStyle(undefined);
      return undefined;
    }
    const update = () => {
      const anchor = anchorRef.current;
      const popover = popoverRef.current;
      if (!anchor || !popover) return;
      setStyle(measureAnchoredPopover(anchor, popover, gap, fallbackWidth));
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorRef, fallbackWidth, gap, open, popoverRef]);

  return style;
}
