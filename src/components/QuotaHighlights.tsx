import { useEffect, useState } from 'react';
import type { QuotaProviderEnvelope } from '../types';
import { validateQuotaProviderEnvelopeStructure } from '../utils/contracts/quota';
import { providerDisplayName, quotaLevel, readQuotaWindow } from '../utils/quotaOverview';
import { companyQuotaWindowLabel, formatReset, isCompanyQuotaProvider, quotaWindowDisplayLabel, selectCompanyQuotaWindows } from './QuotaPanel';
import { Globe2, Network } from 'lucide-react';
import { BrandIcon, resolveBrandIconKey } from './brand/BrandIcon';
import '../styles/quotaHighlights.css';

/** 与完整额度列表共用契约与标签；仅呈现服务商直接提供的可用百分比。 */
export function QuotaHighlights({ providers, refreshFailed, onOpen }: {
  providers: readonly QuotaProviderEnvelope[];
  refreshFailed: boolean;
  onOpen: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const highlights = providers.flatMap(provider => {
    if (!validateQuotaProviderEnvelopeStructure(provider) || !['ok', 'stale'].includes(provider.status)) return [];
    const company = isCompanyQuotaProvider(provider.providerId);
    return (company ? selectCompanyQuotaWindows(provider.windows) : provider.windows).flatMap(window => {
      const reading = readQuotaWindow(window, now);
      if (!reading) return [];
      return [{ ...reading,
        key: JSON.stringify([provider.providerId, provider.scope, window.windowId]),
        providerName: providerDisplayName(provider),
        label: company ? companyQuotaWindowLabel(window.windowId)! : quotaWindowDisplayLabel(window),
        stale: refreshFailed || provider.status === 'stale' || reading.status === 'stale',
      }];
    });
  }).sort((a, b) => a.remaining - b.remaining || ((a.resetsAt ? Date.parse(a.resetsAt) : Infinity) - (b.resetsAt ? Date.parse(b.resetsAt) : Infinity)) || a.key.localeCompare(b.key));
  if (!highlights.length) return null;
  return <section className="quota-highlights" aria-label="首屏额度摘要">
    <div className="quota-highlights-heading">
      <span>额度速览 · 按剩余比例排序</span>
      <button type="button" onClick={onOpen}>查看全部额度{highlights.length > 3 ? `（${highlights.length} 个窗口）` : ''} →</button>
    </div>
    <div className="quota-highlights-items">
      {highlights.slice(0, 3).map(item => <div key={item.key} className="quota-highlight" data-level={item.stale ? 'stale' : quotaLevel(item.remaining)}>
        <div className="quota-highlight-title">
          <span className="quota-highlight-provider">
            {resolveBrandIconKey(item.providerName) ? <BrandIcon name={item.providerName} size={16} /> : (item.providerName.includes('外网') ? <Globe2 size={16} strokeWidth={1.7} aria-hidden="true" /> : <Network size={16} strokeWidth={1.7} aria-hidden="true" />)}
            <strong>{item.providerName}</strong>
          </span>
          <span>{item.label}</span>
        </div>
        <div className="quota-highlight-reading"><strong>{item.remaining}%</strong><span>{item.stale ? '历史可用' : '可用'}</span></div>
        <div className="quota-highlight-meter" aria-hidden="true">
          <span style={{ width: `${Math.max(4, Math.min(100, item.remaining))}%` }} />
        </div>
        <span className="quota-highlight-reset">{item.stale ? (refreshFailed ? '更新失败 · 请刷新后确认' : '历史数据 · 请刷新后确认') : formatReset(item.resetsAt, now)}</span>
      </div>)}
    </div>
  </section>;
}
