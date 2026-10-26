import { Eye, EyeOff, FileText } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t, useLang } from '../../i18n';
import { errorText } from './api';
import { contentSamplingApi, maskSecrets } from './contentSamplingApi';
import type { ContentSample } from './types';
import './contentSampling.css';

export interface ContentSampleSectionProps {
  id: string;
  read?: (id: string) => Promise<ContentSample>;
}

/**
 * Mounted only while its request detail is open and the id is in sampleIds.
 * Unmounting discards both the plaintext and any in-flight read.
 */
export function ContentSampleSection({ id, read = contentSamplingApi.read }: ContentSampleSectionProps) {
  useLang();
  const [sample, setSample] = useState<ContentSample | null>(null);
  const [loading, setLoading] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);

  useEffect(() => () => { ++generation.current; }, []);
  const previousId = useRef(id);
  if (previousId.current !== id) {
    previousId.current = id;
    ++generation.current;
    setSample(null);
    setLoading(false);
    setRevealed(false);
    setError('');
  }

  const load = async () => {
    const mine = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const next = await read(id);
      if (mine === generation.current && next.id === id) setSample(next);
    } catch (reason) {
      if (mine === generation.current) setError(errorText(reason));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  };

  const request = useMemo(() => sample ? (revealed ? sample.request : maskSecrets(sample.request)) : '', [sample, revealed]);
  const response = useMemo(() => sample ? (revealed ? sample.response : maskSecrets(sample.response)) : '', [sample, revealed]);

  return (
    <section className="mw-log-sample" aria-label={t('requestLog.sample.section')}>
      <div className="mw-log-sample-head">
        <h3><FileText className="h-3.5 w-3.5" aria-hidden="true" />{t('requestLog.sample.title')}</h3>
        <span className="mw-chip is-info">{t('requestLog.sample.local')}</span>
        {sample && (
          <button type="button" className="mw-btn is-ghost" aria-pressed={revealed} onClick={() => setRevealed((value) => !value)}>
            {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {revealed ? t('requestLog.sample.hide') : t('requestLog.sample.reveal')}
          </button>
        )}
      </div>
      {!sample ? (
        <div className="mw-log-sample-empty">
          <p>{t('requestLog.sample.lazy')}</p>
          <button type="button" className="secondary-inline" disabled={loading} onClick={() => void load()}>{loading ? t('requestLog.sample.reading') : t('requestLog.sample.read')}</button>
          {error && <p className="mw-caption is-danger" role="alert">{error}</p>}
        </div>
      ) : (
        <>
          <p className="mw-caption">
            {new Date(sample.createdAt).toLocaleString()} · HTTP {sample.status} · {sample.stream ? t('requestLog.fact.stream') : t('requestLog.sample.nonStream')}
            {sample.truncated && <> · {t('requestLog.sample.truncated')}</>}
            {' · '}{revealed ? t('requestLog.sample.raw') : t('requestLog.sample.masked')}
          </p>
          <div className="mw-log-sample-content">
            <div>
              <h4>{t('requestLog.sample.request')}</h4>
              <pre aria-label={t('requestLog.sample.requestAria')}>{request}</pre>
            </div>
            <div>
              <h4>{t('requestLog.sample.response')}</h4>
              <pre aria-label={t('requestLog.sample.responseAria')}>{response}</pre>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
