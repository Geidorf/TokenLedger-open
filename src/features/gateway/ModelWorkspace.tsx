import { useEffect, useState } from 'react';
import { handleWindowDragDoubleClick, handleWindowDragMouseDown } from '../../components/AppHeader';
import type { ModelTab, ToastType } from '../../types';
import type { RequestConfirmation } from '../../utils/confirmation';
import { AgentsPage } from './AgentsPage';
import { gatewayStatus } from './api';
import { GatewayPage } from './GatewayPage';
import { DEFAULT_BASE_URL } from './helpers';
import { ProvidersPage } from './ProvidersPage';
import { RoutingPage } from './RoutingPage';
import type { GatewayStatus } from './types';
import './gateway.css';
import { useT, type MessageKey } from '../../i18n';

const PAGE_COPY: Record<ModelTab, { title: MessageKey; subtitle: MessageKey }> = {
  agents: { title: 'shell.nav.agents', subtitle: 'workspace.agents.subtitle' },
  providers: { title: 'shell.nav.providers', subtitle: 'workspace.providers.subtitle' },
  gateway: { title: 'shell.nav.gateway', subtitle: 'workspace.gateway.subtitle' },
  routing: { title: 'shell.nav.routing', subtitle: 'workspace.routing.subtitle' },
};

export function ModelWorkspaceHeader({ page, onOpenGateway, refreshKey }: { page: ModelTab; onOpenGateway: () => void; refreshKey: number }) {
  const t = useT();
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    gatewayStatus().then((next) => { if (!cancelled) setStatus(next); }).catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [page, refreshKey]);
  const copy = PAGE_COPY[page];
  const address = (status?.baseUrl ?? DEFAULT_BASE_URL).replace(/^https?:\/\//, '').replace(/\/v1$/, '');
  return (
    <header className="app-header mw-header window-drag-surface" onMouseDown={handleWindowDragMouseDown} onDoubleClick={handleWindowDragDoubleClick}>
      <div className="toolbar-brand min-w-0">
        <div className="toolbar-title truncate">
          <span className="toolbar-title-parent">{t('workspace.parent')}</span>
          <span className="toolbar-title-crumb" aria-hidden="true">
            <span className="toolbar-title-sep"> · </span>
          </span>
          <h1>{t(copy.title)}</h1>
        </div>
        <p className="toolbar-subtitle truncate">{t(copy.subtitle)}</p>
      </div>
      <div className="header-controls" data-window-drag-block>
        {page !== 'gateway' && (
          <button type="button" className="mw-gateway-pill" data-window-drag-block onClick={onOpenGateway}>
            <span className={`mw-led ${status?.running ? '' : status?.error ? 'is-danger' : 'is-off'}`} />
            {status?.running ? t('workspace.gatewayRunning', { address }) : t('scene.gatewayStopped')}
          </button>
        )}
      </div>
    </header>
  );
}

export function ModelWorkspaceContent({ page, onPage, onNotify, onConfirm, onChanged }: {
  page: ModelTab;
  onPage: (page: ModelTab) => void;
  onNotify: (type: ToastType, text: string) => void;
  onConfirm: RequestConfirmation;
  onChanged: () => void;
}) {
  return (
    <div className="mw-content">
      {page === 'agents' && <AgentsPage onNotify={onNotify} onConfirm={onConfirm} onOpenProviders={() => onPage('providers')} />}
      {page === 'providers' && <ProvidersPage onNotify={onNotify} onConfirm={onConfirm} onChanged={onChanged} />}
      {page === 'gateway' && <GatewayPage onOpenRouting={() => onPage('routing')} onOpenProviders={() => onPage('providers')} onOpenAgents={() => onPage('agents')} />}
      {page === 'routing' && <RoutingPage onNotify={onNotify} onConfirm={onConfirm} />}
    </div>
  );
}

export default ModelWorkspaceContent;
