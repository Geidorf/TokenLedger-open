import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { GroupIcon, Seg } from '../../prototypes/prototypeKit';
import { formatTokens } from '../../utils/format';
import { errorText, gatewayStatus, listProviders, listRoutingGroups, recentRequests, revealLocalToken } from './api';
import { codeSample, DEFAULT_BASE_URL, effectiveTokens, modelOptions, shortTime, type ModelOption, type SampleApi, type SampleLang } from './helpers';
import type { GatewayStatus, LedgerRecord, ProviderView, RoutingGroup } from './types';
import { CopyButton, ProviderIcon, RevealCopyButton } from './ui';
import { InfoTip } from '../../components/InfoTip';

interface GatewayData {
  status: GatewayStatus;
  providers: ProviderView[];
  groups: RoutingGroup[];
  requests: LedgerRecord[];
}

export function GatewayStatusBar({ status }: { status: GatewayStatus | null }) {
  if (!status) return <span className="mw-caption">读取网关状态…</span>;
  if (status.running) {
    return <><span className="mw-led" /><strong>运行中</strong><span className="mw-faint">·</span><span className="mw-mono-text">{status.baseUrl ?? DEFAULT_BASE_URL}</span></>;
  }
  if (status.error) return <><span className="mw-led is-danger" /><strong>未运行</strong><span className="mw-caption">{status.error}</span></>;
  return <><span className="mw-led is-off" /><strong>未运行</strong><span className="mw-caption">启用至少一个供应商后自动启动（端口 {status.port}）</span></>;
}

/** 目录里的供应商模型与供应商页用同一枚品牌图标，路由组用路由图标。 */
function CatalogIcon({ option, providers }: { option: ModelOption; providers: ProviderView[] }) {
  if (option.isGroup) return <GroupIcon size={22} />;
  const provider = providers.find((item) => item.id === option.providerId);
  if (provider) return <ProviderIcon provider={provider} size={22} />;
  return <span className="mw-brand is-fallback" style={{ width: 22, height: 22, fontSize: 9 }} aria-hidden="true">{option.section.slice(0, 2).toUpperCase()}</span>;
}

export function GatewayPage({ onOpenRouting }: { onOpenRouting: () => void }) {
  const [data, setData] = useState<GatewayData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [api, setApi] = useState<SampleApi>('responses');
  const [lang, setLang] = useState<SampleLang>('curl');
  const [query, setQuery] = useState('');
  const [model, setModel] = useState('');

  const load = useCallback(async () => {
    try {
      const [status, providers, groups, requests] = await Promise.all([gatewayStatus(), listProviders(), listRoutingGroups(), recentRequests(50)]);
      setData({ status, providers, groups, requests });
      setLoadError('');
    } catch (error) {
      setLoadError(errorText(error));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const options = useMemo(() => (data ? modelOptions(data.providers, data.groups) : []), [data]);
  const sampleModel = model || options[0]?.value || '供应商ID/模型';
  const baseUrl = data?.status.baseUrl ?? `http://127.0.0.1:${data?.status.port ?? 3462}/v1`;
  const q = query.trim().toLowerCase();
  const catalog = options.filter((option) => `${option.value} ${option.section}`.toLowerCase().includes(q));
  const status = data?.status ?? null;

  return (
    <div className="mw-page-stack mw-gateway-stack">
      <div className="mw-card mw-status-bar" role="status">
        <GatewayStatusBar status={status} />
        <span className="mw-flex" />
        {status && <span className="mw-caption">{status.enabledCount}/{status.providerCount} 个供应商启用 · {options.length} 个模型</span>}
        <button type="button" className="mw-btn is-ghost" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />刷新</button>
      </div>
      {loadError && <p className="mw-note is-danger" role="alert">读取网关信息失败：{loadError}</p>}

      <div className="mw-card mw-panel">
        <div className="mw-panel-head">
          <h3>接入<InfoTip label="接入说明">
            <span>已接入的 Agent 由 TokenLedger 自动写好；其他客户端（脚本、IDE 插件）照着填。</span>
            <span>示例里的 TOKENLEDGER_TOKEN 是占位符，界面上只显示 token 尾号；点「复制 token」或「复制带 token 的完整示例」时才读取完整本地 token，直接写入剪贴板，不在界面显示或保存。</span>
            <span>网关只监听 127.0.0.1，供应商 key 存在系统钥匙串，不会出现在任何客户端配置中。</span>
          </InfoTip></h3>
        </div>
        <div className="mw-connect">
          <Seg value={api} options={[{ id: 'responses', label: 'OpenAI Responses' }, { id: 'chat', label: 'OpenAI Chat' }]} onChange={setApi} label="接入协议" size="sm" />
          <div className="mw-connect-fields">
            <div className="mw-copy-field">
              <span className="mw-copy-label">Base URL</span>
              <span className="mw-copy-value is-mono">{baseUrl}</span>
              <CopyButton text={baseUrl} label="复制 Base URL" />
            </div>
            <div className="mw-copy-field">
              <span className="mw-copy-label">API 密钥</span>
              <span className="mw-copy-value is-mono">{status?.tokenHint ?? '网关启动后生成'}</span>
              <RevealCopyButton resolve={revealLocalToken} label="复制本地 token">复制 token</RevealCopyButton>
            </div>
            <div className="mw-copy-field">
              <span className="mw-copy-label">模型</span>
              {options.length > 0 ? (
                <select className="mw-native-select is-compact" value={sampleModel} onChange={(event) => setModel(event.target.value)} aria-label="示例模型">
                  {options.map((option) => <option key={option.value} value={option.value}>{option.value}</option>)}
                </select>
              ) : <span className="mw-copy-value is-mono">{sampleModel}</span>}
              <CopyButton text={sampleModel} label="复制模型名" />
            </div>
          </div>
          <div className="mw-code">
            <div className="mw-code-head">
              <Seg value={lang} options={[{ id: 'curl', label: 'curl' }, { id: 'python', label: 'Python' }, { id: 'node', label: 'Node' }]} onChange={setLang} label="示例语言" size="sm" />
              <span className="mw-flex" />
              <CopyButton text={codeSample(api, lang, baseUrl, sampleModel)} label="复制示例代码">复制</CopyButton>
              <RevealCopyButton resolve={async () => codeSample(api, lang, baseUrl, sampleModel, await revealLocalToken())} label="复制带 token 的完整示例">复制带 token 的完整示例</RevealCopyButton>
            </div>
            <pre>{codeSample(api, lang, baseUrl, sampleModel)}</pre>
          </div>
        </div>
      </div>

      <div className="mw-card mw-panel">
        <div className="mw-panel-head">
          <h3>模型目录</h3>
          <div className="mw-panel-tools">
            <label className="mw-search is-inline"><Search className="h-4 w-4" aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型" aria-label="搜索模型目录" /></label>
            <CopyButton text={options.map((option) => option.value).join('\n')} label="复制全部模型 ID">复制全部 ID</CopyButton>
          </div>
        </div>
        {catalog.length === 0 ? <p className="mw-caption">{options.length === 0 ? '还没有可用模型：在供应商页启用供应商并列出模型。' : '没有匹配的模型。'}</p> : (
          <ul className="mw-catalog">
            {catalog.map((option) => (
              <li key={option.value}>
                <CatalogIcon option={option} providers={data?.providers ?? []} />
                <div className="mw-catalog-main">
                  <span className="mw-mono-text">{option.value}</span>
                  <small>{option.isGroup ? option.label : option.section}</small>
                </div>
                <div className="mw-badges">
                  {option.isGroup && <button type="button" className="mw-chip-hit" onClick={onOpenRouting}><span className="mw-chip is-info">路由组</span></button>}
                </div>
                <CopyButton text={option.value} label={`复制 ${option.value}`} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mw-card mw-panel">
        <div className="mw-panel-head">
          <h3>最近请求<InfoTip label="请求记录说明">记录保存在本机，最多显示最近 50 条。</InfoTip></h3>
          <span>有效 Token = 输入 + 输出，缓存读写单列</span>
        </div>
        {data && data.requests.length === 0 ? <p className="mw-caption">还没有经过网关的请求。</p> : (
          <div className="mw-table-wrap">
            <table className="mw-table" aria-label="最近请求">
              <thead>
                <tr>
                  <th>时间</th><th>Agent</th><th>模型</th><th>实际转发</th><th>状态</th>
                  <th className="is-num">有效 Token</th><th className="is-num">输入</th><th className="is-num">输出</th><th className="is-num">缓存读</th><th className="is-num">缓存写</th><th className="is-num">耗时</th>
                </tr>
              </thead>
              <tbody>
                {data?.requests.map((record) => (
                  <tr key={record.requestId}>
                    <td>{shortTime(record.ts)}</td>
                    <td>{record.agent ?? '—'}</td>
                    <td className="mw-mono-text">{record.requestedModel}</td>
                    <td className="mw-mono-text">{record.member ?? `${record.provider}/${record.upstreamModel}`}</td>
                    <td className={record.ok ? '' : 'is-danger'} title={record.error ?? undefined}>{record.status}</td>
                    <td className="is-num">{formatTokens(effectiveTokens(record))}</td>
                    <td className="is-num">{formatTokens(record.input)}</td>
                    <td className="is-num">{formatTokens(record.output)}</td>
                    <td className="is-num">{formatTokens(record.cacheRead)}</td>
                    <td className="is-num">{formatTokens(record.cacheWrite)}</td>
                    <td className="is-num">{(record.latencyMs / 1000).toFixed(1)} s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default GatewayPage;
