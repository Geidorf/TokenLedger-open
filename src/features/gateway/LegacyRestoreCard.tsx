import { useCallback, useEffect, useState } from 'react';
import type { RequestConfirmation } from '../../utils/confirmation';
import { errorText, legacyInspect, legacyRestore } from './api';
import type { LegacyInspection } from './types';
import { t, useLang } from '../../i18n';

export function LegacyRestoreCard({ onConfirm, onResolved, allowGatewayChoice = true }: {
  onConfirm: RequestConfirmation;
  onResolved: (chooseGateway: boolean) => void;
  allowGatewayChoice?: boolean;
}) {
  useLang();
  const [view, setView] = useState<LegacyInspection | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const inspect = useCallback(async () => {
    setBusy(true);
    try {
      const next = await legacyInspect();
      if (!next || typeof next.state !== 'string') throw new Error(t('legacy.invalid'));
      setView(next); setError('');
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void inspect(); }, [inspect]);
  const resolve = async (keep: boolean, choose: boolean) => {
    if (!view?.receiptId || !view.configVersion) return;
    const confirmed = await onConfirm({
      title: keep ? t('legacy.keepTitle') : t('legacy.restoreTitle'),
      description: keep
        ? t('legacy.keepBody')
        : t('legacy.restoreBody'),
      confirmLabel: keep ? t('legacy.keepConfirm') : t('legacy.restoreConfirm'),
    });
    if (!confirmed) return;
    setBusy(true); setError('');
    try {
      const next = await legacyRestore(view.receiptId, view.configVersion, keep);
      setView(next);
      setResult(keep ? t('legacy.keptResult') : choose
        ? t('legacy.restoredChoose')
        : t('legacy.restoredSealed'));
      onResolved(choose);
    } catch (e) {
      setError(errorText(e));
      // The file may be restored even if sealing the receipt failed. A fresh
      // inspection and explicit retry reconcile that case without reapplying.
      try { setView(await legacyInspect()); } catch { /* Keep the actionable original failure. */ }
    } finally { setBusy(false); }
  };
  const pending = view?.receiptId && !['none', 'restored', 'kept'].includes(view.state);
  if (!pending && !error && !result && (!view || view.profileCount === 0)) return null;
  return (
    <section className="mw-card mw-editor" aria-label={t('legacy.title')}>
      <h3>{t('legacy.title')}</h3>
      {pending ? (
        <>
          <p className="mw-caption">{t('legacy.found', { unconfirmed: view.state === 'pending' || view.state === 'indeterminate' ? t('legacy.unconfirmed') : '', next: allowGatewayChoice ? t('legacy.nextGateway') : t('legacy.nextDirect') })}</p>
          {view.reason && <p className="mw-note is-warning">{view.reason}</p>}
          <div className="mw-form-actions">
            <button type="button" className="mw-btn is-primary" disabled={busy || !view.canRestore} onClick={() => void resolve(false, false)}>{t('legacy.restoreRecommended')}</button>
            {allowGatewayChoice && <button type="button" className="mw-btn" disabled={busy || !view.canRestore} onClick={() => void resolve(false, true)}>{t('legacy.restoreThenChoose')}</button>}
            <button type="button" className="mw-btn is-ghost" disabled={busy || !view.configVersion} onClick={() => void resolve(true, false)}>{t('legacy.keepConfirm')}</button>
          </div>
        </>
      ) : view && <p className="mw-caption">{t('legacy.kept', { n: view.profileCount, state: view.state === 'kept' ? t('legacy.state.kept') : view.state === 'restored' ? t('legacy.state.restored') : t('legacy.state.none') })}</p>}
      {result && <p className="mw-note" role="status">{result}</p>}
      {error && <p className="mw-note is-danger" role="alert">{error}</p>}
      {(pending || error) && <button type="button" className="mw-btn is-ghost" disabled={busy} onClick={() => void inspect()}>{busy ? t('legacy.checking') : t('legacy.recheck')}</button>}
    </section>
  );
}
