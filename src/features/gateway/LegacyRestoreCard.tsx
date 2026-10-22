import { useCallback, useEffect, useState } from 'react';
import type { RequestConfirmation } from '../../utils/confirmation';
import { errorText, legacyInspect, legacyRestore } from './api';
import type { LegacyInspection } from './types';

export function LegacyRestoreCard({ onConfirm, onResolved, allowGatewayChoice = true }: {
  onConfirm: RequestConfirmation;
  onResolved: (chooseGateway: boolean) => void;
  allowGatewayChoice?: boolean;
}) {
  const [view, setView] = useState<LegacyInspection | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const inspect = useCallback(async () => {
    setBusy(true);
    try {
      const next = await legacyInspect();
      if (!next || typeof next.state !== 'string') throw new Error('旧版恢复检查未取得有效结果。');
      setView(next); setError('');
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void inspect(); }, [inspect]);
  const resolve = async (keep: boolean, choose: boolean) => {
    if (!view?.receiptId || !view.configVersion) return;
    const confirmed = await onConfirm({
      title: keep ? '保留当前 Codex 配置？' : '恢复旧版 Codex 选择？',
      description: keep
        ? '配置文件保持当前内容。旧恢复入口会标记为“已保留”，旧元数据和恢复凭据仍保存。'
        : '只撤销旧版写入的模型供应商选择键，以及当时受管的模型键。其他配置保持当前内容。恢复只影响新会话。',
      confirmLabel: keep ? '保留当前配置' : '恢复选择',
    });
    if (!confirmed) return;
    setBusy(true); setError('');
    try {
      const next = await legacyRestore(view.receiptId, view.configVersion, keep);
      setView(next);
      setResult(keep ? '已保留当前配置，旧入口已封存。' : choose
        ? '旧版选择已恢复。请在 Codex 行选择网关模型，再预览并确认接入。'
        : '旧版选择已恢复，旧凭据已封存。');
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
    <section className="mw-card mw-editor" aria-label="旧版配置恢复">
      <h3>旧版配置恢复</h3>
      {pending ? (
        <>
          <p className="mw-caption">发现旧版 Codex 恢复凭据{view.state === 'pending' || view.state === 'indeterminate' ? '（上次操作结果尚未确认）' : ''}。{allowGatewayChoice ? '先处理旧选择，再接入网关。' : '可以直接恢复或保留当前配置，无需开启模型接入。'}</p>
          {view.reason && <p className="mw-note is-warning">{view.reason}</p>}
          <div className="mw-form-actions">
            <button type="button" className="mw-btn is-primary" disabled={busy || !view.canRestore} onClick={() => void resolve(false, false)}>恢复旧选择（推荐）</button>
            {allowGatewayChoice && <button type="button" className="mw-btn" disabled={busy || !view.canRestore} onClick={() => void resolve(false, true)}>恢复后选择网关模型</button>}
            <button type="button" className="mw-btn is-ghost" disabled={busy || !view.configVersion} onClick={() => void resolve(true, false)}>保留当前配置</button>
          </div>
        </>
      ) : view && <p className="mw-caption">{view.profileCount} 条旧版配置元数据已保留。{view.state === 'kept' ? '已选择保留当前配置。' : view.state === 'restored' ? '旧版选择已恢复。' : '没有待恢复的 Codex 选择。'}旧配置不会自动复制密钥或接入网关。</p>}
      {result && <p className="mw-note" role="status">{result}</p>}
      {error && <p className="mw-note is-danger" role="alert">{error}</p>}
      {(pending || error) && <button type="button" className="mw-btn is-ghost" disabled={busy} onClick={() => void inspect()}>{busy ? '检查中…' : '重新检查'}</button>}
    </section>
  );
}
