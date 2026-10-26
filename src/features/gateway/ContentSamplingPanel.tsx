import { EyeOff, ShieldCheck, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t, useLang } from '../../i18n';
import type { ToastType } from '../../types';
import { errorText } from './api';
import { contentSamplingApi } from './contentSamplingApi';
import type { ContentSamplingInput, ContentSamplingMode, ContentSamplingStatus } from './types';
import { useModalFocus } from './useModalFocus';
import './contentSampling.css';

export const CONTENT_SAMPLING_POLL_MS = 5000;

export interface SamplingController {
  status: ContentSamplingStatus | null;
  error: string | null;
  refresh: () => Promise<void>;
  replace: (status: ContentSamplingStatus) => void;
}

/** Polling is generation-guarded: a status read started before an action cannot overwrite its result. */
export function useContentSamplingStatus(enabled = true): SamplingController {
  const [status, setStatus] = useState<ContentSamplingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    const mine = ++generation.current;
    inFlight.current = true;
    try {
      const next = await contentSamplingApi.status();
      if (mine !== generation.current) return;
      setStatus(next);
      setError(next.error);
    } catch (reason) {
      if (mine === generation.current) setError(errorText(reason));
    } finally {
      if (mine === generation.current) inFlight.current = false;
    }
  }, []);

  const replace = useCallback((next: ContentSamplingStatus) => {
    ++generation.current;
    inFlight.current = false;
    setStatus(next);
    setError(next.error);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, CONTENT_SAMPLING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);

  return { status, error, refresh, replace };
}

function Modal({ title, description, busy, onClose, children }: {
  title: string;
  description?: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useModalFocus(dialog, onClose);
  return createPortal(
    <div className="modal-overlay confirm-overlay" data-gateway-modal role="presentation" onClick={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section ref={dialog} tabIndex={-1} className="modal-content confirm-dialog content-sampling-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}>
        <div className="confirm-dialog-icon" aria-hidden="true"><ShieldCheck className="h-5 w-5" /></div>
        <div className="confirm-dialog-copy">
          <h2 id={titleId} className="confirm-dialog-title">{title}</h2>
          {description && <p id={descriptionId} className="confirm-dialog-description">{description}</p>}
          {children}
        </div>
      </section>
    </div>,
    document.body,
  );
}

type Dialog = 'enable' | 'stop' | 'delete' | null;

export function ContentSamplingPanel({ compact = false, controller, onNotify }: {
  compact?: boolean;
  controller?: SamplingController;
  onNotify?: (type: ToastType, text: string) => void;
}) {
  useLang();
  const ownSampling = useContentSamplingStatus(controller == null);
  const sampling = controller ?? ownSampling;
  const status = sampling.status;
  const active = status != null && status.mode !== 'off';
  const [dialog, setDialog] = useState<Dialog>(null);
  const [mode, setMode] = useState<Exclude<ContentSamplingMode, 'off'>>('next');
  const [count, setCount] = useState(20);
  const [durationHours, setDurationHours] = useState(24);
  const [agent, setAgent] = useState('');
  const [group, setGroup] = useState('');
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [deleteExisting, setDeleteExisting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  const closeDialog = () => {
    if (!busy) {
      setDialog(null);
      setFormError('');
    }
  };

  const openEnable = () => {
    setMode('next');
    setConfirmed(false);
    setFormError('');
    setDialog('enable');
  };

  const openStop = () => {
    setDeleteExisting(true);
    setFormError('');
    setDialog('stop');
  };

  const run = async (task: () => Promise<ContentSamplingStatus>, success: string) => {
    setBusy(true);
    setFormError('');
    try {
      sampling.replace(await task());
      setDialog(null);
      onNotify?.('success', success);
    } catch (reason) {
      setFormError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const enable = () => {
    if (!confirmed) {
      setFormError(t('sampling.error.confirm'));
      return;
    }
    if (mode === 'filter' && !failuresOnly && !agent.trim() && !group.trim()) {
      setFormError(t('sampling.error.filter'));
      return;
    }
    const input: ContentSamplingInput = mode === 'next'
      ? { mode, count: Math.max(1, Math.min(200, count || 20)), confirmed: true }
      : {
          mode,
          agent: agent.trim() || null,
          group: group.trim() || null,
          failuresOnly,
          durationHours: Math.max(1, Math.min(24, durationHours || 24)),
          confirmed: true,
        };
    void run(() => contentSamplingApi.set(input), t('sampling.notify.enabled'));
  };

  const stop = () => {
    void run(
      () => contentSamplingApi.set({ mode: 'off', deleteExisting }),
      deleteExisting ? t('sampling.notify.stoppedDeleted') : t('sampling.notify.stoppedKept'),
    );
  };

  const removeAll = () => {
    void run(() => contentSamplingApi.remove(null), t('sampling.notify.deleted'));
  };

  const stateLabel = active
    ? t('sampling.state.active')
    : status
      ? t('sampling.state.off')
      : t('sampling.state.loading');
  const detail = active
    ? status.mode === 'next'
      ? t('sampling.detail.next', { count: status.remaining ?? 0 })
      : [
          status.agent && t('sampling.detail.agent', { value: status.agent }),
          status.group && t('sampling.detail.group', { value: status.group }),
          status.failuresOnly && t('sampling.detail.failuresOnly'),
          status.expiresAt && t('sampling.detail.expires', {
            duration: t('sampling.hours', { count: Math.max(1, Math.ceil((Date.parse(status.expiresAt) - Date.now()) / 3_600_000)) }),
          }),
        ].filter(Boolean).join(' · ')
    : t('sampling.detail.off');

  return (
    <>
      <section className={`${compact ? '' : 'mw-card mw-panel '}content-sampling${compact ? ' is-compact' : ''}${active ? ' is-active' : ''}`} aria-label={t('sampling.title')}>
        <div className="content-sampling-head">
          <div className="content-sampling-title">
            <span className="content-sampling-mark" aria-hidden="true">{active ? <EyeOff className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}</span>
            <div>
              <h2>{t('sampling.title')}</h2>
              <p>{detail}</p>
            </div>
          </div>
          <button type="button" role="switch" aria-checked={active} aria-label={t('sampling.switchLabel')} disabled={!status || busy} className={`mw-switch ${active ? 'is-on' : ''}`} onClick={() => (active ? openStop() : openEnable())}><span /></button>
        </div>
        <div className="content-sampling-foot">
          <span className={`content-sampling-state${active ? ' is-active' : ''}`}>{stateLabel}</span>
          {status && <span>{t('sampling.stored', { count: status.storedCount, size: formatBytes(status.storedBytes) })}</span>}
          {!compact && <span>{t('sampling.policy')}</span>}
          <span className="mw-flex" />
          {status && status.storedCount > 0 && <button type="button" className="mw-btn is-ghost" disabled={busy} onClick={() => setDialog('delete')}><Trash2 className="h-3.5 w-3.5" />{t('sampling.deleteAll')}</button>}
          {!active && status && <button type="button" className="mw-btn is-ghost" disabled={busy} onClick={openEnable}>{t('sampling.configure')}</button>}
        </div>
        {sampling.error && <p className="mw-caption is-danger" role="alert">{sampling.error}</p>}
      </section>

      {dialog === 'enable' && (
        <Modal title={t('sampling.enable.title')} description={t('sampling.enable.lead')} busy={busy} onClose={closeDialog}>
          <div className="content-sampling-form">
            <div className="mw-seg is-sm" role="radiogroup" aria-label={t('sampling.mode.label')}>
              <button type="button" role="radio" aria-checked={mode === 'next'} className={mode === 'next' ? 'is-on' : ''} onClick={() => setMode('next')}>{t('sampling.mode.next')}</button>
              <button type="button" role="radio" aria-checked={mode === 'filter'} className={mode === 'filter' ? 'is-on' : ''} onClick={() => setMode('filter')}>{t('sampling.mode.filter')}</button>
            </div>
            {mode === 'next' ? (
              <label className="content-sampling-field">{t('sampling.count')}<input type="number" min={1} max={200} value={count} onChange={(event) => setCount(Number(event.target.value))} /></label>
            ) : (
              <>
                <p className="mw-caption">{t('sampling.agentGroupHint')}</p>
                <div className="content-sampling-grid">
                  <label className="content-sampling-field">{t('sampling.agent')}<input value={agent} onChange={(event) => setAgent(event.target.value)} placeholder={t('sampling.any')} /></label>
                  <label className="content-sampling-field">{t('sampling.group')}<input value={group} onChange={(event) => setGroup(event.target.value)} placeholder={t('sampling.any')} /></label>
                  <label className="content-sampling-field">{t('sampling.duration')}<input type="number" min={1} max={24} value={durationHours} onChange={(event) => setDurationHours(Number(event.target.value))} /></label>
                </div>
                <label className="content-sampling-check"><input type="checkbox" checked={failuresOnly} onChange={(event) => setFailuresOnly(event.target.checked)} />{t('sampling.failuresOnly')}</label>
              </>
            )}
            <ul className="content-sampling-warning">
              <li>{t('sampling.warning.content')}</li>
              <li>{t('sampling.warning.context')}</li>
              <li>{t('sampling.warning.attachments')}</li>
              <li>{t('sampling.warning.storage')}</li>
              <li>{t('sampling.warning.limits')}</li>
            </ul>
            <label className="content-sampling-check is-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{t('sampling.confirm')}</label>
            {formError && <p className="mw-caption is-danger" role="alert">{formError}</p>}
            <footer className="confirm-dialog-actions">
              <button type="button" className="ghost-inline" disabled={busy} onClick={closeDialog}>{t('sampling.cancel')}</button>
              <button type="button" className="primary-inline" disabled={busy || !confirmed} onClick={enable}>{t('sampling.enable.action')}</button>
            </footer>
          </div>
        </Modal>
      )}

      {dialog === 'stop' && (
        <Modal title={t('sampling.stop.title')} description={t('sampling.stop.lead')} busy={busy} onClose={closeDialog}>
          <div className="content-sampling-form">
            <label className="content-sampling-check"><input type="checkbox" checked={deleteExisting} onChange={(event) => setDeleteExisting(event.target.checked)} />{t('sampling.stop.deleteExisting')}</label>
            <p className="mw-caption">{deleteExisting ? t('sampling.stop.deleteHint') : t('sampling.stop.keepHint')}</p>
            {formError && <p className="mw-caption is-danger" role="alert">{formError}</p>}
            <footer className="confirm-dialog-actions">
              <button type="button" className="ghost-inline" disabled={busy} onClick={closeDialog}>{t('sampling.cancel')}</button>
              <button type="button" className={deleteExisting ? 'danger-inline' : 'primary-inline'} disabled={busy} onClick={stop}>{deleteExisting ? t('sampling.stop.actionDelete') : t('sampling.stop.actionKeep')}</button>
            </footer>
          </div>
        </Modal>
      )}

      {dialog === 'delete' && (
        <Modal title={t('sampling.delete.title')} description={t('sampling.delete.lead')} busy={busy} onClose={closeDialog}>
          <div className="content-sampling-form">
            {formError && <p className="mw-caption is-danger" role="alert">{formError}</p>}
            <footer className="confirm-dialog-actions">
              <button type="button" className="ghost-inline" disabled={busy} onClick={closeDialog}>{t('sampling.cancel')}</button>
              <button type="button" className="danger-inline" disabled={busy} onClick={removeAll}>{t('sampling.delete.action')}</button>
            </footer>
          </div>
        </Modal>
      )}
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
