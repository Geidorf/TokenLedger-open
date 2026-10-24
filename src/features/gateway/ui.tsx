import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from './useModalFocus';
import { Check, Copy, X } from 'lucide-react';
import '../../prototypes/model-workspace-prototype.css';
import './gateway.css';
import { BrandIcon } from '../../prototypes/prototypeKit';
import { presetFor } from './presets';
import { t, useLang } from '../../i18n';

/** 供应商品牌图标：供应商页与网关模型目录共用，认不出的供应商退回字母徽标。 */
export function ProviderIcon({ provider, size }: { provider: { id: string; baseUrl: string; name: string }; size: number }) {
  const preset = presetFor(provider);
  return <BrandIcon id={preset?.icon} fallback={preset?.monogram ?? provider.name.slice(0, 2).toUpperCase()} size={size} />;
}

export function Sheet({ title, subtitle, icon, onClose, children }: { title: string; subtitle: string; icon: ReactNode; onClose: () => void; children: ReactNode }) {
  useLang();
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  useModalFocus(dialog, onClose);
  return createPortal(
    <div className="mw-sheet-layer" data-gateway-modal role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside ref={dialog} tabIndex={-1} className="mw-sheet mw-add-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="mw-sheet-head">
          {icon}
          <div className="mw-card-title"><strong id={titleId}>{title}</strong><span>{subtitle}</span></div>
          <button type="button" className="mw-icon-btn" aria-label={t('ui.close')} onClick={onClose}><X className="h-4 w-4" /></button>
        </header>
        {children}
      </aside>
    </div>, document.body,
  );
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label, children }: { text: string; label: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={children ? 'mw-btn is-ghost' : 'mw-icon-btn'}
      aria-label={label}
      title={label}
      onClick={() => { void writeClipboard(text).then(setCopied); }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

/**
 * Fetches the text only when clicked and never keeps it: the resolved value
 * goes straight to the clipboard, so secrets stay out of React state.
 */
export function RevealCopyButton({ resolve, label, children }: { resolve: () => Promise<string>; label: string; children: ReactNode }) {
  useLang();
  const [state, setState] = useState<'idle' | 'busy' | 'copied' | 'failed'>('idle');
  const [error, setError] = useState('');
  useEffect(() => {
    if (state !== 'copied' && state !== 'failed') return;
    const timer = window.setTimeout(() => setState('idle'), state === 'copied' ? 1600 : 4000);
    return () => window.clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    setState('busy');
    try {
      const ok = await writeClipboard(await resolve());
      setError(ok ? '' : t('ui.copy.clipboardFailed'));
      setState(ok ? 'copied' : 'failed');
    } catch (cause) {
      setError(typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : t('ui.copy.readFailed'));
      setState('failed');
    }
  };
  return (
    <>
      <button type="button" className="mw-btn is-ghost" aria-label={label} title={label} disabled={state === 'busy'} onClick={() => { void copy(); }}>
        {state === 'copied' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {state === 'copied' ? t('ui.copy.copied') : children}
      </button>
      <span className="mw-caption" role="status" aria-live="polite">{state === 'failed' ? t('ui.copy.failed', { error }) : ''}</span>
    </>
  );
}
