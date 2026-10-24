import { useEffect, useState } from 'react';
import { handleWindowDragDoubleClick, handleWindowDragMouseDown } from '../../components/AppHeader';
import type { ModelTab, ToastType } from '../../types';
import type { RequestConfirmation } from '../../utils/confirmation';
import { AgentsPage } from './AgentsPage';
import { gatewayStatus } from './api';
import { GatewayPage } from './GatewayPage';
import { DEFAULT_BASE_URL } from './helpers';
import { ProvidersPage } from './ProvidersPage';
import { RequestLogPage } from './RequestLogPage';
import { RoutingPage } from './RoutingPage';
import type { GatewayStatus } from './types';
import './gateway.css';

const PAGE_COPY: Record<ModelTab, { title: string; subtitle: string }> = {
  agents: { title: 'Agent', subtitle: '给本机 Agent 选模型或路由组，请求经本机网关转发并记账。' },
  providers: { title: '供应商', subtitle: '添加 API key，模型就出现在 Agent 和路由组的选择器里。' },
  gateway: { title: '网关', subtitle: '本机 127.0.0.1 上的统一入口：协议转换、记账、路由。' },
  gatewaylog: { title: '请求日志', subtitle: '每次经网关的请求：路由原因、尝试顺序、Token、费用与耗时。只存元数据。' },
  routing: { title: '路由', subtitle: '把多个供应商的模型合成一个虚拟模型，按规则选择、失败自动切换。' },
};

export function ModelWorkspaceHeader({ page, onOpenGateway, refreshKey }: { page: ModelTab; onOpenGateway: () => void; refreshKey: number }) {
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
          <span className="toolbar-title-parent">模型接入</span>
          <span className="toolbar-title-crumb" aria-hidden="true">
            <span className="toolbar-title-sep"> · </span>
          </span>
          <h1>{copy.title}</h1>
        </div>
        <p className="toolbar-subtitle truncate">{copy.subtitle}</p>
      </div>
      <div className="header-controls" data-window-drag-block>
        {page !== 'gateway' && (
          <button type="button" className="mw-gateway-pill" data-window-drag-block onClick={onOpenGateway}>
            <span className={`mw-led ${status?.running ? '' : status?.error ? 'is-danger' : 'is-off'}`} />
            {status?.running ? `网关运行中 · ${address}` : '网关未运行'}
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
      {page === 'gateway' && <GatewayPage onOpenRouting={() => onPage('routing')} onOpenProviders={() => onPage('providers')} onOpenAgents={() => onPage('agents')} onOpenRequestLog={() => onPage('gatewaylog')} />}
      {page === 'gatewaylog' && <RequestLogPage onNotify={onNotify} />}
      {page === 'routing' && <RoutingPage onNotify={onNotify} onConfirm={onConfirm} />}
    </div>
  );
}

export default ModelWorkspaceContent;
