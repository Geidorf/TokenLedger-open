import { useModalFocus } from './useModalFocus';
import { AlertTriangle, Plug } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { AppSettings } from '../../types';
import { SettingsCard, SettingsGroup, SettingsToggleRow } from '../../components/settings/SettingsPrimitives';
import { errorText, setModelAccess } from './api';
import { SUPPORTED_AGENTS, type AgentAdapter } from './agents';

export interface ModelAccessCardProps {
  /** undefined：设置还没读到，开关先禁用。 */
  enabled: boolean | undefined;
  onChanged: (settings: AppSettings) => void;
  onNotify: (message: string) => void;
  agents?: AgentAdapter[];
}

export interface AgentCloseState {
  agent: AgentAdapter;
  state: 'onGateway' | 'offGateway' | 'unreadable';
  error?: string;
  result?: 'restored' | 'unchanged' | 'failed';
}

/** A failed inspection is unknown, never evidence that closing is safe. */
export async function inspectCloseAgents(agents: AgentAdapter[]): Promise<AgentCloseState[]> {
  return Promise.all(agents.map(async (agent) => {
    try { return { agent, state: (await agent.inspect()).pointsToGateway ? 'onGateway' : 'offGateway' } as AgentCloseState; }
    catch (error) { return { agent, state: 'unreadable', error: errorText(error) } as AgentCloseState; }
  }));
}

export function ModelAccessCard({ enabled, onChanged, onNotify, agents = SUPPORTED_AGENTS }: ModelAccessCardProps) {
  const triggerRef = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AgentCloseState[] | null>(null);

  const apply = async (next: boolean) => {
    onChanged(await setModelAccess(next));
  };

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } catch (error) {
      onNotify(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (next: boolean) => {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return run(async () => {
    if (next) {
      await apply(true);
      return;
    }
    const checked = await inspectCloseAgents(agents);
    if (checked.every((item) => item.state === 'offGateway')) {
      await apply(false);
      return;
    }
    setPending(checked);
    });
  };

  const retryInspection = (id: string) => run(async () => {
    const item = pending?.find((entry) => entry.agent.id === id);
    if (!item) return;
    const [checked] = await inspectCloseAgents([item.agent]);
    setPending((current) => current?.map((entry) => entry.agent.id === id ? { ...checked, result: entry.result } : entry) ?? null);
  });

  const restoreAndClose = (items: AgentCloseState[]) => run(async () => {
    const results: AgentCloseState[] = [];
    for (const item of items) {
      if (item.result === 'restored' || item.state === 'offGateway' || item.state === 'unreadable') {
        results.push({ ...item, result: item.result ?? 'unchanged' });
        continue;
      }
      try {
        await item.agent.restore(false);
        const [checked] = await inspectCloseAgents([item.agent]);
        results.push({ ...checked, result: 'restored' });
      } catch (error) {
        const [checked] = await inspectCloseAgents([item.agent]);
        results.push({ ...checked, result: 'failed', error: errorText(error) });
      }
      setPending([...results, ...items.slice(results.length)]);
    }
    setPending(results);
    const failed = results.filter((item) => item.result === 'failed');
    if (failed.length) onNotify(`部分配置未恢复，模型接入保持开启。${failed.map((item) => `${item.agent.name}：${item.error}`).join('；')}`);
    if (results.every((item) => item.state === 'offGateway') && failed.length === 0) {
      await apply(false);
      onNotify('原配置已恢复，模型接入已关闭；逐项结果保留在窗口中。');
    }
  });

  return (
    <SettingsCard title="总开关">
      <SettingsGroup>
        <SettingsToggleRow
          label="模型接入"
          hint="本地网关、供应商、Agent 与路由。已用 CC Switch 等工具管理时可保持关闭。"
          icon={Plug}
          checked={enabled === true}
          disabled={enabled === undefined || busy}
          busy={busy}
          onChange={(next) => void toggle(next)}
        />
      </SettingsGroup>
      {pending && (
        <ModelAccessCloseDialog
          items={pending}
          triggerRef={triggerRef}
          busy={busy}
          onRetry={(id) => void retryInspection(id)}
          onRestore={() => void restoreAndClose(pending)}
          onCloseOnly={() => {
            setPending(null);
            void run(() => apply(false));
          }}
          onCancel={() => { if (!busy) setPending(null); }}
        />
      )}
    </SettingsCard>
  );
}

interface ModelAccessCloseDialogProps {
  triggerRef: RefObject<HTMLElement | null>;
  items: AgentCloseState[];
  busy: boolean;
  onRetry: (id: string) => void;
  onRestore: () => void;
  onCloseOnly: () => void;
  onCancel: () => void;
}

export function ModelAccessCloseDialog({ items, triggerRef, busy, onRetry, onRestore, onCloseOnly, onCancel }: ModelAccessCloseDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  useModalFocus(dialogRef, onCancel, triggerRef);
  const hasResults = items.some((item) => item.result);
  useEffect(() => { if (hasResults && !busy) summaryRef.current?.focus(); }, [hasResults, busy]);
  return createPortal(
    <div className="modal-overlay confirm-overlay" data-gateway-modal role="presentation" onClick={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <section ref={dialogRef} className="modal-content confirm-dialog confirm-dialog-primary" role="alertdialog" aria-modal="true" aria-labelledby="model-access-close-title" aria-describedby="model-access-close-description" tabIndex={-1}>
        <div className="confirm-dialog-icon" aria-hidden="true"><AlertTriangle className="h-5 w-5" /></div>
        <div className="confirm-dialog-copy">
          <h2 id="model-access-close-title" className="confirm-dialog-title">关闭模型接入</h2>
          <p ref={summaryRef} tabIndex={-1} id="model-access-close-description" className="confirm-dialog-description" role="status" aria-live="polite">
            {hasResults ? '恢复结果（已重新读取磁盘状态）' : '这些 Agent 仍指向本地网关，关闭后将无法使用'}：{items.filter((item) => item.state !== 'offGateway' || item.result).map((item) => item.agent.name).join('、')}
          </p>
          <p>检查失败时保持开启。选择「仅关闭」不会恢复配置，仍指向网关或无法检查的 Agent 可能无法使用。</p>
          <ul>{items.filter((item) => item.state !== 'offGateway' || item.result).map((item) => (
            <li key={item.agent.id}>
              {item.agent.name} · {item.result === 'restored' ? '已恢复' : item.result === 'failed' ? '恢复失败' : item.result === 'unchanged' ? '未改变' : '未恢复'} · {item.state === 'onGateway' ? '仍指向网关' : item.state === 'offGateway' ? '已离开网关' : '检查失败'}
              {item.error && <span role="alert">：{item.error}</span>}
              {item.state === 'unreadable' && <button type="button" className="ghost-inline" disabled={busy} onClick={() => onRetry(item.agent.id)}>重试检查 {item.agent.name}</button>}
            </li>
          ))}</ul>
        </div>
        <footer className="confirm-dialog-actions">
          <button data-initial-focus className="ghost-inline" type="button" disabled={busy} onClick={onCancel}>{hasResults ? '完成' : '取消'}</button>
          <button className="ghost-inline" type="button" disabled={busy} onClick={onCloseOnly}>仅关闭</button>
          <button className="primary-inline" type="button" disabled={busy || items.some((item) => item.state === 'unreadable') || !items.some((item) => item.state === 'onGateway' && item.result !== 'restored')} onClick={onRestore}>{hasResults ? '重试失败项并关闭' : '恢复原配置并关闭'}</button>
        </footer>
      </section>
    </div>, document.body,
  );
}
