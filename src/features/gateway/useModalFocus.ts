import { useEffect, useRef, type RefObject } from 'react';

/** Shared modal lifecycle: contain keyboard/pointer interaction and restore the trigger. */
export function useModalFocus(ref: RefObject<HTMLElement | null>, onClose: () => void, triggerRef?: RefObject<HTMLElement | null>) {
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const trigger = triggerRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const portal = dialog.closest('[data-gateway-modal]');
    const isTop = () => { const modals = document.querySelectorAll('[aria-modal="true"]'); return modals[modals.length - 1] === dialog; };
    let lastFocused: HTMLElement | null = null;
    const syncLayer = () => {
      if (!(portal instanceof HTMLElement)) return;
      const suspended = portal.inert;
      portal.inert = !isTop();
      if (!isTop()) portal.setAttribute('aria-hidden', 'true');
      else {
        portal.removeAttribute('aria-hidden');
        if (suspended && !dialog.contains(document.activeElement)) (lastFocused?.isConnected ? lastFocused : dialog).focus();
      }
    };
    const background = Array.from(document.body.children).filter((node): node is HTMLElement => node instanceof HTMLElement && node !== portal);
    const previous = background.map((node) => ({ node, inert: node.inert, hidden: node.getAttribute('aria-hidden') }));
    previous.forEach(({ node }) => { node.inert = true; node.setAttribute('aria-hidden', 'true'); });
    const items = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')).filter((node) => !node.closest('[hidden], [inert]'));
    (dialog.querySelector<HTMLElement>('[data-initial-focus], input:not(:disabled), textarea:not(:disabled)') ?? items()[0] ?? dialog).focus();
    const key = (event: KeyboardEvent) => {
      if (!isTop()) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== 'Tab') return;
      const controls = items();
      const first = controls[0]; const last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      }
    };
    const focus = (event: FocusEvent) => {
      if (!isTop()) return;
      if (dialog.contains(event.target as Node)) lastFocused = event.target instanceof HTMLElement ? event.target : null;
      else (items()[0] ?? dialog).focus();
    };
    const observer = new MutationObserver(() => {
      if (!isTop()) return;
      if (!dialog.contains(document.activeElement)) (dialog.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled)') ?? items()[0] ?? dialog).focus();
    });
    observer.observe(dialog, { childList: true, subtree: true });
    lastFocused = document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement) ? document.activeElement : null;
    const layers = new MutationObserver(syncLayer);
    layers.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('keydown', key);
    document.addEventListener('focusin', focus);
    return () => {
      observer.disconnect(); layers.disconnect();
      document.removeEventListener('keydown', key); document.removeEventListener('focusin', focus);
      previous.forEach(({ node, inert, hidden }) => { node.inert = inert; if (hidden === null) node.removeAttribute('aria-hidden'); else node.setAttribute('aria-hidden', hidden); });
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [ref, triggerRef]);
}
