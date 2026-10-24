import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronDown, RefreshCw, X } from 'lucide-react';
import { formatNum, formatTokens } from '../utils/format';
import { sessionAnalysisReason, type SessionAnalysis, type SessionAnalysisRecord, type SessionTurn } from '../types/sessionAnalysis';
import '../styles/sessionAnalysis.css';
import { getLang, t, useLang } from '../i18n';

function timeLabel(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return t('session.time.unknown');
  return new Date(value).toLocaleString(getLang() === 'en' ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * 逐轮 Token 数量改用别处一致的紧凑格式（K/M），而不是全位数 formatNum
 * （审计 P2）。次数类数字（请求、轮次）不是 Token，继续用 formatNum。
 * 非有限或负值一律显示“不可得”，不回退成 0（GLB-01）。
 */
function formatTokenCount(value: number): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? formatTokens(value) : t('session.unavailable');
}

function TurnRow({ turn, toolCallsKnown }: { turn: SessionTurn; toolCallsKnown: boolean }) {
  const splitKnown = turn.cacheReadTokens !== undefined && turn.cacheWriteTokens !== undefined;
  return <details className="session-turn">
    <summary aria-label={t('session.turn.aria', { n: turn.ordinal, requests: turn.requestCount })}>
      <span className="session-turn-identity"><strong>{t('session.turn.title', { n: turn.ordinal })}</strong><small>{timeLabel(turn.startedAt)}</small></span>
      <span className="session-turn-number"><small>{t('session.input')}</small>{formatTokenCount(turn.inputTokens)}</span>
      <span className="session-turn-number"><small>{t('session.output')}</small>{formatTokenCount(turn.outputTokens)}</span>
      <span className="session-turn-number session-turn-cache"><small>{t('session.cache')}</small>{formatTokenCount(turn.cachedTokens)}</span>
      <ChevronDown size={16} aria-hidden="true" />
    </summary>
    <div className="session-turn-detail">
      <p>{t('session.turn.requests', { n: formatNum(turn.requestCount) })} · {t(turn.status === 'complete' ? 'session.turn.done' : turn.status === 'in_progress' ? 'session.turn.running' : 'session.turn.unknown')}</p>
      <dl>
        <div><dt>{t('session.model')}</dt><dd>{turn.models.length ? turn.models.join(t('session.joiner')) : t('session.unknown')}</dd></div>
        <div><dt>{t('session.toolCalls')}</dt><dd>{!toolCallsKnown ? t('session.toolCalls.unknown') : turn.tools.length ? turn.tools.map(tool => `${tool.name} × ${tool.count}`).join(t('session.joiner')) : t('session.none')}</dd></div>
        <div><dt>{t('session.cacheSplit')}</dt><dd>{splitKnown ? t('session.cacheSplit.value', { read: formatTokenCount(turn.cacheReadTokens!), write: formatTokenCount(turn.cacheWriteTokens!) }) : t('session.cacheSplit.unknown')}</dd></div>
        {turn.endedAt && <div><dt>{t('session.endedAt')}</dt><dd>{timeLabel(turn.endedAt)}</dd></div>}
      </dl>
    </div>
  </details>;
}

export default function SessionAnalysisDrawer({ record, onClose }: { record: SessionAnalysisRecord; onClose: () => void }) {
  useLang();
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [analysis, setAnalysis] = useState<SessionAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [visibleTurns, setVisibleTurns] = useState(50);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const surface = dialog.current!;
    surface.showModal();
    closeButton.current?.focus();
    const onCancel = (event: Event) => { event.preventDefault(); onCloseRef.current(); };
    surface.addEventListener('cancel', onCancel);
    return () => {
      surface.removeEventListener('cancel', onCancel);
      surface.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    let current = true;
    const requestId = crypto.randomUUID();
    setLoading(true);
    setFailed(false);
    setAnalysis(null);
    setVisibleTurns(50);
    void invoke<SessionAnalysis>('get_local_session_analysis', { recordId: record.id, requestId }).then(result => {
      if (!current) return;
      // Unknown / stale IPC responses cannot be attributed to this selected record.
      if (result.recordId !== record.id || !['ready', 'partial', 'unavailable'].includes(result.status)
          || (result.status !== 'unavailable' && (result.sessionId !== record.sessionId || result.tool.toLowerCase() !== record.tool.toLowerCase() || !result.coverage.matchedRecord))) {
        setFailed(true);
      } else setAnalysis(result);
    }).catch(() => { if (current) setFailed(true); }).finally(() => { if (current) setLoading(false); });
    return () => {
      current = false;
      void invoke('cancel_local_session_analysis', { requestId }).catch(() => undefined);
    };
  }, [record.id, record.sessionId, record.tool, revision]);

  const turns = analysis?.turns || [];
  const totals = turns.reduce((sum, turn) => ({ tokens: sum.tokens + turn.inputTokens + turn.outputTokens, requests: sum.requests + turn.requestCount }), { tokens: 0, requests: 0 });
  const ready = analysis && analysis.status !== 'unavailable';
  return <dialog ref={dialog} className="session-analysis-drawer" aria-labelledby="session-analysis-title">
    <header className="session-analysis-header">
      <div><span className="session-analysis-eyebrow">{t('session.eyebrow', { tool: record.tool })}</span><h2 id="session-analysis-title">{t('session.title')}</h2></div>
      <button ref={closeButton} type="button" className="session-analysis-icon" onClick={onClose} aria-label={t('session.close')}><X size={20} /></button>
    </header>
    <div className="session-analysis-content" aria-busy={loading}>
      <p className="session-analysis-intro">{t('session.intro')}</p>
      <code className="session-analysis-id">{record.sessionId}</code>
      {loading ? <div className="session-analysis-state" role="status">{t('session.loading')}</div> : failed || !ready ? <div className="session-analysis-state" role="status"><h3>{t('session.failed')}</h3><p>{sessionAnalysisReason(analysis?.reason)}</p></div> : <>
        {analysis.status === 'partial' && <p className="session-analysis-notice" role="status">{t('session.partial')}{analysis.reason ? sessionAnalysisReason(analysis.reason) : ''}</p>}
        <div className="session-analysis-totals">
          <div><span>{t(analysis.status === 'partial' ? 'session.tokensConfirmed' : 'session.tokens')}</span><strong>{formatTokenCount(totals.tokens)}</strong></div>
          <div><span>{t('session.userTurns')}</span><strong>{formatNum(turns.length)}</strong></div>
          <div><span>{t('session.requests')}</span><strong>{formatNum(totals.requests)}</strong></div>
        </div>
        <div className="session-analysis-list-label"><h3>{t('session.list')}</h3><span>{t('session.list.note')}</span></div>
        <div className="session-analysis-turns">{turns.slice(0, visibleTurns).map(turn => <TurnRow key={turn.id} turn={turn} toolCallsKnown={analysis.coverage.toolCallsKnown} />)}</div>
        {visibleTurns < turns.length && <button className="session-analysis-more" type="button" onClick={() => setVisibleTurns(value => value + 50)}>{t('session.more', { n: Math.min(50, turns.length - visibleTurns) })}</button>}
        {analysis.unassignedUsage && <p className="session-analysis-notice">{t('session.unassigned', { requests: formatNum(analysis.unassignedUsage.requestCount), tokens: formatTokenCount(analysis.unassignedUsage.inputTokens + analysis.unassignedUsage.outputTokens), cached: formatTokenCount(analysis.unassignedUsage.cachedTokens) })}</p>}
      </>}
    </div>
    <footer className="session-analysis-footer"><span>{ready ? t('session.readAt', { time: timeLabel(analysis.observedAt) }) : t('session.onDemand')}</span><button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} aria-hidden="true" />{t('session.reread')}</button></footer>
  </dialog>;
}
