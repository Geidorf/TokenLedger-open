import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronDown, RefreshCw, X } from 'lucide-react';
import { formatNum, formatTokens } from '../utils/format';
import { sessionAnalysisReason, type SessionAnalysis, type SessionAnalysisRecord, type SessionTurn } from '../types/sessionAnalysis';
import '../styles/sessionAnalysis.css';

function timeLabel(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间未知';
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * 逐轮 Token 数量改用别处一致的紧凑格式（K/M），而不是全位数 formatNum
 * （审计 P2）。次数类数字（请求、轮次）不是 Token，继续用 formatNum。
 * 非有限或负值一律显示“不可得”，不回退成 0（GLB-01）。
 */
function formatTokenCount(value: number): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? formatTokens(value) : '不可得';
}

function TurnRow({ turn, toolCallsKnown }: { turn: SessionTurn; toolCallsKnown: boolean }) {
  const splitKnown = turn.cacheReadTokens !== undefined && turn.cacheWriteTokens !== undefined;
  return <details className="session-turn">
    <summary aria-label={`第 ${turn.ordinal} 轮，${turn.requestCount} 次请求，查看详情`}>
      <span className="session-turn-identity"><strong>第 {turn.ordinal} 轮</strong><small>{timeLabel(turn.startedAt)}</small></span>
      <span className="session-turn-number"><small>输入</small>{formatTokenCount(turn.inputTokens)}</span>
      <span className="session-turn-number"><small>输出</small>{formatTokenCount(turn.outputTokens)}</span>
      <span className="session-turn-number session-turn-cache"><small>缓存</small>{formatTokenCount(turn.cachedTokens)}</span>
      <ChevronDown size={16} aria-hidden="true" />
    </summary>
    <div className="session-turn-detail">
      <p>{formatNum(turn.requestCount)} 次请求 · {turn.status === 'complete' ? '已结束' : turn.status === 'in_progress' ? '进行中' : '结束状态未知'}</p>
      <dl>
        <div><dt>模型</dt><dd>{turn.models.length ? turn.models.join('、') : '未知'}</dd></div>
        <div><dt>工具调用</dt><dd>{!toolCallsKnown ? '来源未提供完整调用信息' : turn.tools.length ? turn.tools.map(tool => `${tool.name} × ${tool.count}`).join('、') : '无'}</dd></div>
        <div><dt>缓存构成</dt><dd>{splitKnown ? `读取 ${formatTokenCount(turn.cacheReadTokens!)} · 写入 ${formatTokenCount(turn.cacheWriteTokens!)}` : '来源未提供读写拆分'}</dd></div>
        {turn.endedAt && <div><dt>结束时间</dt><dd>{timeLabel(turn.endedAt)}</dd></div>}
      </dl>
    </div>
  </details>;
}

export default function SessionAnalysisDrawer({ record, onClose }: { record: SessionAnalysisRecord; onClose: () => void }) {
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
      <div><span className="session-analysis-eyebrow">{record.tool} · 本机会话</span><h2 id="session-analysis-title">逐轮分析</h2></div>
      <button ref={closeButton} type="button" className="session-analysis-icon" onClick={onClose} aria-label="关闭逐轮分析"><X size={20} /></button>
    </header>
    <div className="session-analysis-content" aria-busy={loading}>
      <p className="session-analysis-intro">分析整个会话，不受当前明细筛选限制。仅提取用量与工具元数据，不展示或上传对话正文。</p>
      <code className="session-analysis-id">{record.sessionId}</code>
      {loading ? <div className="session-analysis-state" role="status">正在读取本机会话…</div> : failed || !ready ? <div className="session-analysis-state" role="status"><h3>暂时无法逐轮分析</h3><p>{sessionAnalysisReason(analysis?.reason)}</p></div> : <>
        {analysis.status === 'partial' && <p className="session-analysis-notice" role="status">部分用量无法归属到可靠轮次。下方只展示已确认部分。{analysis.reason ? sessionAnalysisReason(analysis.reason) : ''}</p>}
        <div className="session-analysis-totals">
          <div><span>{analysis.status === 'partial' ? '已确认有效 Token' : '有效 Token'}</span><strong>{formatTokenCount(totals.tokens)}</strong></div>
          <div><span>用户轮次</span><strong>{formatNum(turns.length)}</strong></div>
          <div><span>请求</span><strong>{formatNum(totals.requests)}</strong></div>
        </div>
        <div className="session-analysis-list-label"><h3>轮次明细</h3><span>输入 + 输出为有效 Token · 缓存单列</span></div>
        <div className="session-analysis-turns">{turns.slice(0, visibleTurns).map(turn => <TurnRow key={turn.id} turn={turn} toolCallsKnown={analysis.coverage.toolCallsKnown} />)}</div>
        {visibleTurns < turns.length && <button className="session-analysis-more" type="button" onClick={() => setVisibleTurns(value => value + 50)}>显示接下来 {Math.min(50, turns.length - visibleTurns)} 轮</button>}
        {analysis.unassignedUsage && <p className="session-analysis-notice">未归属轮次：{formatNum(analysis.unassignedUsage.requestCount)} 次请求，{formatTokenCount(analysis.unassignedUsage.inputTokens + analysis.unassignedUsage.outputTokens)} 有效 Token，{formatTokenCount(analysis.unassignedUsage.cachedTokens)} 缓存 Token。</p>}
      </>}
    </div>
    <footer className="session-analysis-footer"><span>{ready ? `读取于 ${timeLabel(analysis.observedAt)}` : '原始日志仅在本机按需读取'}</span><button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} aria-hidden="true" />重新读取</button></footer>
  </dialog>;
}
