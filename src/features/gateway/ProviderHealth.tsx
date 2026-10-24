import { useCallback, useEffect, useMemo, useState } from 'react';
import { errorText, probeProviders, providerHealth, setHealthProbe } from './api';
import { traceReasonLabel } from './helpers';
import type { HealthBucket, HealthReport, HealthStats, HealthStatus, ProbeResult, ProbeSettings, ProviderHealth } from './types';
import './providerHealth.css';
import { getLang, localized, t, useLang } from '../../i18n';

export const HEALTH_LABEL = localized<HealthStatus>({ healthy: 'health.status.healthy', degraded: 'health.status.degraded', down: 'health.status.down', idle: 'health.status.idle' });
const HEALTH_TONE: Record<HealthStatus, string> = { healthy: 'is-success', degraded: 'is-warning', down: 'is-danger', idle: '' };
const POLL_MS = 30_000;

/** The health report, refreshed every 30 s while the window is visible. */
export function useHealthReport(): [HealthReport | null, (next: HealthReport) => void] {
  const [report, setReport] = useState<HealthReport | null>(null);
  useEffect(() => {
    let alive = true;
    // A failed refresh drops the old report instead of showing it as current.
    const load = () => providerHealth().then((next) => { if (alive) setReport(next); }).catch(() => { if (alive) setReport(null); });
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  return [report, setReport];
}

export function healthByProvider(report: HealthReport | null): Map<string, ProviderHealth> {
  return new Map((report?.providers ?? []).map((item) => [item.provider, item]));
}

/** Health of every provider, refreshed every 30 s while the window is visible. */
export function useProviderHealth(): Map<string, ProviderHealth> {
  const [report] = useHealthReport();
  return useMemo(() => healthByProvider(report), [report]);
}

export const PROBE_INTERVALS = [5, 15, 30, 60, 120];

/** Optional active probe: off by default; a click probes once even while off. */
export function ProbeBar({ settings, onReport, onNotify }: { settings: ProbeSettings | undefined; onReport: (next: HealthReport) => void; onNotify: (type: 'success' | 'error', text: string) => void }) {
  useLang();
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<ProbeSettings | null>(null);
  const current = local ?? settings ?? { enabled: false, intervalMins: 15 };
  const save = useCallback(async (next: ProbeSettings) => {
    setBusy(true);
    try {
      setLocal(await setHealthProbe(next));
      onReport(await providerHealth());
    } catch (error) {
      onNotify('error', t('health.probe.saveFailed', { error: errorText(error) }));
    } finally {
      setBusy(false);
    }
  }, [onNotify, onReport]);
  const probeNow = async () => {
    setBusy(true);
    try {
      onReport(await probeProviders());
      onNotify('success', t('health.probe.done'));
    } catch (error) {
      onNotify('error', t('health.probe.failed', { error: errorText(error) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mw-probe-bar" role="group" aria-label={t('health.probe.group')}>
      <button type="button" role="switch" aria-checked={current.enabled} aria-label={t('health.probe.title')} disabled={busy} className={`mw-switch ${current.enabled ? 'is-on' : ''}`} onClick={() => void save({ ...current, enabled: !current.enabled })}><span /></button>
      <span className="mw-probe-text">
        <strong>{t('health.probe.title')}</strong>
        <small>{t('health.probe.hint')}</small>
      </span>
      <label className="mw-probe-interval">
        <span>{t('health.probe.interval')}</span>
        <select className="mw-select" value={current.intervalMins} disabled={busy || !current.enabled} onChange={(event) => void save({ ...current, intervalMins: Number(event.target.value) })}>
          {PROBE_INTERVALS.map((mins) => <option key={mins} value={mins}>{t('health.probe.mins', { n: mins })}</option>)}
        </select>
      </label>
      <button type="button" className="mw-btn is-ghost" disabled={busy} onClick={() => void probeNow()}>{t('health.probe.now')}</button>
    </div>
  );
}

function probeLine(probe: ProbeResult): string {
  const at = clock(probe.ts);
  if (probe.ok) return t('health.probe.lineOk', { at, latency: formatMs(probe.latencyMs) });
  const reason = traceReasonLabel(probe.code);
  return probe.status ? t('health.probe.lineFailedHttp', { at, reason, status: probe.status }) : t('health.probe.lineFailed', { at, reason });
}

export function formatMs(ms: number | null): string {
  if (ms == null) return '—';
  return ms >= 10_000 ? t('health.sec', { n: Math.round(ms / 1000) }) : ms >= 1000 ? t('health.sec', { n: (ms / 1000).toFixed(1) }) : t('health.ms', { n: ms });
}

export function formatRate(rate: number | null): string {
  if (rate == null) return '—';
  const pct = rate * 100;
  return `${pct >= 99.95 || pct === 0 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

/** One line: why a provider is not healthy, or its volume and success rate. */
export function healthSummary(health: ProviderHealth): string {
  const { stats } = health;
  const reasons = health.reasons.map(traceReasonLabel).join(t('health.joiner'));
  if (health.status === 'idle') return t('health.summary.idle');
  if (stats.requests === 0) return reasons || (health.probes?.[0]?.ok ? t('health.summary.probeOk') : t('health.summary.noUpstream'));
  const base = t('health.summary.base', { requests: stats.requests, rate: formatRate(stats.successRate), p95: formatMs(stats.p95Ms) });
  return reasons ? `${base} · ${reasons}` : base;
}

export function HealthBadge({ health, compact = false }: { health: ProviderHealth | undefined; compact?: boolean }) {
  useLang();
  if (!health) return null;
  const label = HEALTH_LABEL[health.status];
  const title = healthSummary(health);
  // Own class names: `.is-warning` on a member row already means 「冷却中」.
  if (compact) return <span className={`mw-health-dot is-${health.status}`} role="img" aria-label={t('health.badgeAria', { label })} title={`${label} · ${title}`} />;
  return <span className={`mw-chip mw-health-chip ${HEALTH_TONE[health.status]}`} title={title}><i aria-hidden="true" />{label}</span>;
}

/** 24 hourly bars, oldest left: height is volume, the dark top part is failures. */
export function HealthSpark({ buckets, label }: { buckets: HealthBucket[]; label: string }) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.requests));
  const failed = buckets.reduce((sum, bucket) => sum + bucket.failed, 0);
  const total = buckets.reduce((sum, bucket) => sum + bucket.requests, 0);
  const width = buckets.length * 4;
  return (
    <svg className="mw-health-spark" viewBox={`0 0 ${width} 20`} width={width} height={20} role="img" aria-label={t('health.sparkAria', { label, total, failed })}>
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
      <div><dt>{t('health.stat.requests')}</dt><dd>{stats.requests}</dd></div>
      <div><dt>{t('health.stat.success')}</dt><dd>{formatRate(stats.successRate)}</dd></div>
      <div><dt>{t('health.stat.p50')}</dt><dd>{formatMs(stats.p50Ms)}</dd></div>
      <div><dt>{t('health.stat.p95')}</dt><dd>{formatMs(stats.p95Ms)}</dd></div>
      <div><dt>{t('health.stat.rateLimited')}</dt><dd>{stats.rateLimited}</dd></div>
    </dl>
  );
}

function clock(ts: string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleTimeString(getLang() === 'en' ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/** Full health section for the provider sheet. */
export function HealthDetail({ health, name }: { health: ProviderHealth | undefined; name: string }) {
  useLang();
  if (!health) return null;
  const { stats } = health;
  return (
    <section className="mw-health" aria-label={t('health.sectionAria', { name })}>
      <div className="mw-health-head">
        <h4>{t('health.title')}</h4>
        <HealthBadge health={health} />
        <span className="mw-flex" />
        <HealthSpark buckets={health.buckets} label={name} />
      </div>
      <p className="mw-health-note">{t(health.probes?.length ? 'health.noteWithProbe' : 'health.note', { summary: healthSummary(health) })}</p>
      {health.probes?.[0] && <p className={`mw-health-note ${health.probes[0].ok ? '' : 'is-warning'}`}>{probeLine(health.probes[0])}</p>}
      {health.status !== 'idle' && <StatGrid stats={stats} />}
      {stats.codes.length > 0 && (
        <div className="mw-health-codes" aria-label={t('health.codesAria')}>
          {stats.codes.map((item) => <span key={item.code} className="mw-chip">{traceReasonLabel(item.code)} × {item.count}</span>)}
          {stats.statuses.map((item) => <span key={item.status} className="mw-chip mw-mono-text">HTTP {item.status} × {item.count}</span>)}
        </div>
      )}
      {health.cooling.length > 0 && (
        <p className="mw-health-note is-warning">{t('health.cooling', { items: health.cooling.map((item) => t('health.coolingItem', { member: item.member, secs: item.remainingSecs })).join(t('health.joiner')) })}</p>
      )}
      {health.models.length > 1 && (
        <table className="mw-table mw-health-models">
          <thead><tr><th>{t('health.col.model')}</th><th>{t('health.col.status')}</th><th>{t('health.col.requests')}</th><th>{t('health.col.success')}</th><th>P95</th></tr></thead>
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
          <h5>{t('health.recentFailures')}</h5>
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
