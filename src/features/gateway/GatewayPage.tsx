import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Boxes, RefreshCw, Search } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { GroupIcon, Seg } from '../../prototypes/prototypeKit';
import { formatTokens } from '../../utils/format';
import { errorText, gatewayStatus, listProviders, listRoutingGroups, recentRequests, recentRouteDecisions, revealLocalToken } from './api';
import { codeSample, DEFAULT_BASE_URL, effectiveTokens, modelOptions, shortTime, traceHeadline, type ModelOption, type SampleApi, type SampleLang } from './helpers';
import type { GatewayStatus, LedgerRecord, ProviderView, RouteDecision, RoutingGroup } from './types';
import { DecisionTrace } from './DecisionTrace';
import { CopyButton, ProviderIcon, RevealCopyButton } from './ui';
import { InfoTip } from '../../components/InfoTip';
import { t, useLang } from '../../i18n';

interface GatewayData {
  status: GatewayStatus;
  providers: ProviderView[];
  groups: RoutingGroup[];
  requests: LedgerRecord[];
  /** Group decisions by the logical request id the ledger records carry. */
  decisions: Map<string, RouteDecision>;
}

/** Why this attempt's member was used or passed over, from the decision trace. */
function attemptWhy(record: LedgerRecord, decision: RouteDecision | undefined): string | null {
  const member = record.member ?? `${record.provider}/${record.upstreamModel}`;
  const item = decision?.trace?.find((entry) => entry.member === member);
  return item ? traceHeadline(item.reasons) : null;
}

export function GatewayStatusBar({ status }: { status: GatewayStatus | null }) {
  useLang();
  if (!status) return <span className="mw-caption">{t('gateway.status.loading')}</span>;
  if (status.running) {
    return <><span className="mw-led" /><strong>{t('gateway.status.running')}</strong><span className="mw-faint">·</span><span className="mw-mono-text">{status.baseUrl ?? DEFAULT_BASE_URL}</span></>;
  }
  if (status.error) return <><span className="mw-led is-danger" /><strong>{t('gateway.status.stopped')}</strong><span className="mw-caption">{status.error}</span></>;
  return <><span className="mw-led is-off" /><strong>{t('gateway.status.stopped')}</strong><span className="mw-caption">{t('gateway.status.autoStart', { port: status.port })}</span></>;
}

/** 目录里的供应商模型与供应商页用同一枚品牌图标，路由组用路由图标。 */
function CatalogIcon({ option, providers }: { option: ModelOption; providers: ProviderView[] }) {
  if (option.isGroup) return <GroupIcon size={22} />;
  const provider = providers.find((item) => item.id === option.providerId);
  if (provider) return <ProviderIcon provider={provider} size={22} />;
  return <span className="mw-brand is-fallback" style={{ width: 22, height: 22, fontSize: 9 }} aria-hidden="true">{option.section.slice(0, 2).toUpperCase()}</span>;
}

export function GatewayPage({ onOpenRouting, onOpenProviders, onOpenAgents, onOpenRequestLog }: { onOpenRouting: () => void; onOpenProviders?: () => void; onOpenAgents?: () => void; onOpenRequestLog?: () => void }) {
  // Labels read the current language directly; subscribing re-renders the page when it changes.
  const uiLang = useLang();
  const [data, setData] = useState<GatewayData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [api, setApi] = useState<SampleApi>('responses');
  const [lang, setLang] = useState<SampleLang>('curl');
  const [query, setQuery] = useState('');
  const [model, setModel] = useState('');
  const [openTrace, setOpenTrace] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // Decisions only explain group requests; the page works without them.
      const [status, providers, groups, requests, recent] = await Promise.all([
        gatewayStatus(), listProviders(), listRoutingGroups(), recentRequests(50), recentRouteDecisions(200).catch(() => [] as RouteDecision[]),
      ]);
      setData({ status, providers, groups, requests, decisions: new Map(recent.map((decision) => [decision.requestId, decision])) });
      setLoadError('');
    } catch (error) {
      setLoadError(errorText(error));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `uiLang` re-derives the translated section labels
  const options = useMemo(() => (data ? modelOptions(data.providers, data.groups) : []), [data, uiLang]);
  const sampleModel = model || options[0]?.value || t('gateway.sample.modelPlaceholder');
  const baseUrl = data?.status.baseUrl ?? `http://127.0.0.1:${data?.status.port ?? 3462}/v1`;
  const q = query.trim().toLowerCase();
  const catalog = options.filter((option) => `${option.value} ${option.section}`.toLowerCase().includes(q));
  const status = data?.status ?? null;

  return (
    <div className="mw-page-stack mw-gateway-stack">
      <div className="mw-card mw-status-bar" role="status">
        <GatewayStatusBar status={status} />
        <span className="mw-flex" />
        {status && <span className="mw-caption">{t('gateway.summary', { enabled: status.enabledCount, total: status.providerCount, models: options.length })}</span>}
        <button type="button" className="mw-btn is-ghost" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />{t('gateway.refresh')}</button>
      </div>
      {loadError && <p className="mw-note is-danger" role="alert">{t('gateway.loadError', { error: loadError })}</p>}

      <div className="mw-card mw-panel">
        <div className="mw-panel-head">
          <h2>{t('gateway.connect.title')}<InfoTip label={t('gateway.connect.info')}>
            <span>{t('gateway.connect.infoAgents')}</span>
            <span>{t('gateway.connect.infoToken')}</span>
            <span>{t('gateway.connect.infoLocal')}</span>
          </InfoTip></h2>
        </div>
        <div className="mw-connect">
          <Seg value={api} options={[{ id: 'responses', label: 'OpenAI Responses' }, { id: 'chat', label: 'OpenAI Chat' }]} onChange={setApi} label={t('gateway.connect.protocol')} size="sm" />
          <div className="mw-connect-fields">
            <div className="mw-copy-field">
              <span className="mw-copy-label">Base URL</span>
              <span className="mw-copy-value is-mono">{baseUrl}</span>
              <CopyButton text={baseUrl} label={t('gateway.connect.copyBaseUrl')} />
            </div>
            <div className="mw-copy-field">
              <span className="mw-copy-label">{t('gateway.connect.apiKey')}</span>
              <span className="mw-copy-value is-mono">{status?.tokenHint ?? t('gateway.connect.tokenPending')}</span>
              <RevealCopyButton resolve={revealLocalToken} label={t('gateway.connect.copyTokenLabel')}>{t('gateway.connect.copyToken')}</RevealCopyButton>
            </div>
            <div className="mw-copy-field">
              <span className="mw-copy-label">{t('gateway.connect.model')}</span>
              {options.length > 0 ? (
                <select className="mw-native-select is-compact" value={sampleModel} onChange={(event) => setModel(event.target.value)} aria-label={t('gateway.connect.sampleModel')}>
                  {options.map((option) => <option key={option.value} value={option.value}>{option.value}</option>)}
                </select>
              ) : <span className="mw-copy-value is-mono">{sampleModel}</span>}
              <CopyButton text={sampleModel} label={t('gateway.connect.copyModel')} />
            </div>
          </div>
          <div className="mw-code">
            <div className="mw-code-head">
              <Seg value={lang} options={[{ id: 'curl', label: 'curl' }, { id: 'python', label: 'Python' }, { id: 'node', label: 'Node' }]} onChange={setLang} label={t('gateway.connect.sampleLanguage')} size="sm" />
              <span className="mw-flex" />
              <CopyButton text={codeSample(api, lang, baseUrl, sampleModel)} label={t('gateway.connect.copySampleLabel')}>{t('gateway.connect.copy')}</CopyButton>
              <RevealCopyButton resolve={async () => codeSample(api, lang, baseUrl, sampleModel, await revealLocalToken())} label={t('gateway.connect.copyFullSample')}>{t('gateway.connect.copyFullSample')}</RevealCopyButton>
            </div>
            <pre>{codeSample(api, lang, baseUrl, sampleModel)}</pre>
          </div>
        </div>
      </div>

      <div className="mw-card mw-panel">
        <div className="mw-panel-head">
          <h2>{t('gateway.catalog.title')}</h2>
          <div className="mw-panel-tools">
            <label className="mw-search is-inline"><Search className="h-4 w-4" aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('gateway.catalog.search')} aria-label={t('gateway.catalog.searchLabel')} /></label>
            <CopyButton text={options.map((option) => option.value).join('\n')} label={t('gateway.catalog.copyAllLabel')}>{t('gateway.catalog.copyAll')}</CopyButton>
          </div>
        </div>
        {catalog.length === 0 ? (options.length === 0 ? (
          <EmptyState variant="inset" icon={Boxes} title={t('empty.gatewayModels.title')} description={t('empty.gatewayModels.description')}>
            {onOpenProviders && <button type="button" className="secondary-inline" onClick={onOpenProviders}>{t('empty.gatewayModels.action')}</button>}
          </EmptyState>
        ) : <p className="mw-caption">{t('gateway.catalog.noMatch')}</p>) : (
          <ul className="mw-catalog">
            {catalog.map((option) => (
              <li key={option.value}>
                <CatalogIcon option={option} providers={data?.providers ?? []} />
                <div className="mw-catalog-main">
                  <span className="mw-mono-text">{option.value}</span>
                  <small>{option.isGroup ? option.label : option.section}</small>
                </div>
                <div className="mw-badges">
                  {option.isGroup && <button type="button" className="mw-chip-hit" onClick={onOpenRouting}><span className="mw-chip is-info">{t('gateway.catalog.group')}</span></button>}
                </div>
                <CopyButton text={option.value} label={t('gateway.catalog.copyOne', { value: option.value })} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mw-card mw-panel">
        <div className="mw-panel-head">
          <h2>{t('gateway.requests.title')}<InfoTip label={t('gateway.requests.info')}>{t('gateway.requests.infoBody')}</InfoTip></h2>
          <span>{t('gateway.requests.effective')}</span>
          {onOpenRequestLog && <button type="button" className="mw-btn is-ghost" onClick={onOpenRequestLog}>{t('gateway.requests.openLog')}</button>}
        </div>
        {data && data.requests.length === 0 ? (
          <EmptyState variant="inset" icon={Bot} title={t('empty.gatewayRequests.title')} description={t('empty.gatewayRequests.description')}>
            {onOpenAgents && <button type="button" className="secondary-inline" onClick={onOpenAgents}>{t('empty.gatewayRequests.action')}</button>}
          </EmptyState>
        ) : (
          <div className="mw-table-wrap">
            <table className="mw-table" aria-label={t('gateway.requests.title')}>
              <thead>
                <tr>
                  <th>{t('gateway.requests.col.time')}</th><th>Agent</th><th>{t('gateway.requests.col.model')}</th><th>{t('gateway.requests.col.routed')}</th><th>{t('gateway.requests.col.status')}</th>
                  <th className="is-num">{t('gateway.requests.col.effective')}</th><th className="is-num">{t('gateway.requests.col.input')}</th><th className="is-num">{t('gateway.requests.col.output')}</th><th className="is-num">{t('gateway.requests.col.cacheRead')}</th><th className="is-num">{t('gateway.requests.col.cacheWrite')}</th><th className="is-num">{t('gateway.requests.col.duration')}</th>
                </tr>
              </thead>
              <tbody>
                {data?.requests.map((record) => {
                  const decision = record.group ? data.decisions.get(record.logicalRequestId ?? record.requestId) : undefined;
                  const why = attemptWhy(record, decision);
                  const open = openTrace === record.requestId;
                  return (
                    <Fragment key={record.requestId}>
                      <tr>
                        <td>{shortTime(record.ts)}</td>
                        <td>{record.agent ?? '—'}</td>
                        <td className="mw-mono-text">{record.requestedModel}</td>
                        <td className="mw-mono-text">
                          {record.member ?? `${record.provider}/${record.upstreamModel}`}
                          {decision && (
                            <button type="button" className="mw-chip-hit mw-trace-open" aria-expanded={open} aria-label={t(open ? 'gateway.requests.whyHide' : 'gateway.requests.whyShow')} onClick={() => setOpenTrace(open ? null : record.requestId)}>
                              <span className={`mw-chip ${record.ok ? 'is-info' : 'is-warning'}`}>{why ?? t('gateway.requests.why')}</span>
                            </button>
                          )}
                        </td>
                        <td className={record.ok ? '' : 'is-danger'} title={record.error ?? undefined}>{record.status}</td>
                        <td className="is-num">{formatTokens(effectiveTokens(record))}</td>
                        <td className="is-num">{formatTokens(record.input)}</td>
                        <td className="is-num">{formatTokens(record.output)}</td>
                        <td className="is-num">{formatTokens(record.cacheRead)}</td>
                        <td className="is-num">{formatTokens(record.cacheWrite)}</td>
                        <td className="is-num">{(record.latencyMs / 1000).toFixed(1)} s</td>
                      </tr>
                      {open && decision && (
                        <tr className="mw-trace-row">
                          <td colSpan={11}><DecisionTrace decision={decision} /></td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default GatewayPage;
