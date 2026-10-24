import { useEffect, useMemo, useState } from 'react';
import { providerHealth } from './api';
import { traceReasonLabel } from './helpers';
import type { HealthBucket, HealthReport, HealthStats, HealthStatus, ProviderHealth } from './types';
import './providerHealth.css';

export const HEALTH_LABEL: Record<HealthStatus, string> = { healthy: '健康', degraded: '降级', down: '故障', idle: '无流量' };
const HEALTH_TONE: Record<HealthStatus, string> = { healthy: 'is-success', degraded: 'is-warning', down: 'is-danger', idle: '' };
const POLL_MS = 30_000;

/** Health of every provider, refreshed every 30 s while the window is visible. */
export function useProviderHealth(): Map<string, ProviderHealth> {
  const [report, setReport] = useState<HealthReport | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => providerHealth().then((next) => { if (alive) setReport(next); }).catch(() => undefined);
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  return useMemo(() => new Map((report?.providers ?? []).map((item) => [item.provider, item])), [report]);
}

export function formatMs(ms: number | null): string {
  if (ms == null) return '—';
  return ms >= 10_000 ? `${Math.round(ms / 1000)} 秒` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${ms} 毫秒`;
}

export function formatRate(rate: number | null): string {
  if (rate == null) return '—';
  const pct = rate * 100;
  return `${pct >= 99.95 || pct === 0 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

/** One line: why a provider is not healthy, or its volume and success rate. */
export function healthSummary(health: ProviderHealth): string {
  const { stats } = health;
  const reasons = health.reasons.map(traceReasonLabel).join('、');
  if (health.status === 'idle') return '近 24 小时没有经网关的请求';
  if (stats.requests === 0) return reasons || '请求都没有发到上游';
  const base = `近 24 小时 ${stats.requests} 次 · 成功 ${formatRate(stats.successRate)} · P95 ${formatMs(stats.p95Ms)}`;
  return reasons ? `${base} · ${reasons}` : base;
}

export function HealthBadge({ health, compact = false }: { health: ProviderHealth | undefined; compact?: boolean }) {
  if (!health) return null;
  const label = HEALTH_LABEL[health.status];
  const title = healthSummary(health);
  // Own class names: `.is-warning` on a member row already means 「冷却中」.
  if (compact) return <span className={`mw-health-dot is-${health.status}`} role="img" aria-label={`健康度：${label}`} title={`${label} · ${title}`} />;
  return <span className={`mw-chip mw-health-chip ${HEALTH_TONE[health.status]}`} title={title}><i aria-hidden="true" />{label}</span>;
}

/** 24 hourly bars, oldest left: height is volume, the dark top part is failures. */
export function HealthSpark({ buckets, label }: { buckets: HealthBucket[]; label: string }) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.requests));
  const failed = buckets.reduce((sum, bucket) => sum + bucket.failed, 0);
  const total = buckets.reduce((sum, bucket) => sum + bucket.requests, 0);
  const width = buckets.length * 4;
  return (
    <svg className="mw-health-spark" viewBox={`0 0 ${width} 20`} width={width} height={20} role="img" aria-label={`${label}近 24 小时 ${total} 次请求，${failed} 次失败`}>
      {buckets.map((bucket, index) => {
        const h = bucket.requests === 0 ? 1 : Math.max(2, Math.round((bucket.requests / max) * 20));
        const bad = bucket.requests === 0 ? 0 : Math.round((bucket.failed / bucket.requests) * h);
        return (
          <g key={bucket.start}>
            <rect className={bucket.requests === 0 ? 'is-empty' : 'is-ok'} x={index * 4} y={20 - h} width={3} height={h} rx={0.5} />
            {bad > 0 && <rect className="is-failed" x={index * 4} y={20 - h} width={3} height={Math.max(1, bad)} rx={0.5} />}
          </g>
        );
      })}
    </svg>
  );
}

function StatGrid({ stats }: { stats: HealthStats }) {
  return (
    <dl className="mw-health-stats">
      <div><dt>请求</dt><dd>{stats.requests}</dd></div>
      <div><dt>成功率</dt><dd>{formatRate(stats.successRate)}</dd></div>
      <div><dt>P50 耗时</dt><dd>{formatMs(stats.p50Ms)}</dd></div>
      <div><dt>P95 耗时</dt><dd>{formatMs(stats.p95Ms)}</dd></div>
      <div><dt>限流</dt><dd>{stats.rateLimited}</dd></div>
    </dl>
  );
}

function clock(ts: string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/** Full health section for the provider sheet. */
export function HealthDetail({ health, name }: { health: ProviderHealth | undefined; name: string }) {
  if (!health) return null;
  const { stats } = health;
  return (
    <section className="mw-health" aria-label={`${name} 健康度`}>
      <div className="mw-health-head">
        <h4>健康度</h4>
        <HealthBadge health={health} />
        <span className="mw-flex" />
        <HealthSpark buckets={health.buckets} label={name} />
      </div>
      <p className="mw-health-note">{healthSummary(health)}。只统计经本机网关的请求，不额外访问供应商。</p>
      {health.status !== 'idle' && <StatGrid stats={stats} />}
      {stats.codes.length > 0 && (
        <div className="mw-health-codes" aria-label="错误分布">
          {stats.codes.map((item) => <span key={item.code} className="mw-chip">{traceReasonLabel(item.code)} × {item.count}</span>)}
          {stats.statuses.map((item) => <span key={item.status} className="mw-chip mw-mono-text">HTTP {item.status} × {item.count}</span>)}
        </div>
      )}
      {health.cooling.length > 0 && (
        <p className="mw-health-note is-warning">冷却中：{health.cooling.map((item) => `${item.member}（约 ${item.remainingSecs} 秒）`).join('、')}，路由组暂时把它排到其余成员之后。</p>
      )}
      {health.models.length > 1 && (
        <table className="mw-table mw-health-models">
          <thead><tr><th>模型</th><th>状态</th><th>请求</th><th>成功率</th><th>P95</th></tr></thead>
          <tbody>
            {health.models.map((model) => (
              <tr key={model.model}>
                <td className="mw-mono-text">{model.model}</td>
                <td>{HEALTH_LABEL[model.status]}</td>
                <td>{model.stats.requests}</td>
                <td>{formatRate(model.stats.successRate)}</td>
                <td>{formatMs(model.stats.p95Ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {health.recentFailures.length > 0 && (
        <div className="mw-health-failures">
          <h5>最近失败</h5>
          <ul>
            {health.recentFailures.map((item) => (
              <li key={`${item.ts}-${item.model}`}>
                <span className="mw-health-when">{clock(item.ts)}</span>
                <span className="mw-mono-text">{item.model}</span>
                <span className="mw-chip">{traceReasonLabel(item.code)}</span>
                {item.error && <small>{item.error}</small>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
