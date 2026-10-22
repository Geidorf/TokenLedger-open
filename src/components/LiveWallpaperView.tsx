import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AppSettings, DataScope, StatsData, StatsQueryContext } from '../types';
import { formatEstimatedUsd, formatNum, formatTokens } from '../utils/format';
import { buildWallpaperSnapshot, isHistoricalWallpaperSnapshot } from '../utils/liveWallpaper';
import { normalizeStatsQuery, parseStatsDataContract, queryEchoMatches, scopeMachineSelection } from '../utils/contracts/statsQuery';
import { createVisibleStatsReconciler } from '../utils/statsRefreshSubscription';
import '../styles/live-wallpaper.css';

interface WallpaperIdentity { scope: DataScope; deviceFilter: string; timezone: string; query: StatsQueryContext; }
interface WallpaperStatsSnapshot { stats: StatsData; identity: WallpaperIdentity; loadedAt: Date; }

function localDateLabel(now: Date): string { return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(now); }
function formatSnapshotTime(value: string | null | undefined, format: Intl.DateTimeFormatOptions): string {
  if (!value) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', format).format(date);
}
function Clock({ now }: { now: Date }) {
  return <header className="live-wallpaper__clock"><time className="live-wallpaper__time" dateTime={now.toISOString()}>{now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time><p>{localDateLabel(now)}</p></header>;
}
function Trend({ values, historical }: { values: number[]; historical: boolean }) {
  if (values.length < 2 || values.every((value) => value === 0)) return <span className="live-wallpaper__muted">暂无可绘制走势</span>;
  const max = Math.max(...values, 1);
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${100 - (value / max) * 100}`).join(' ');
  return <svg className="live-wallpaper__trend" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label={historical ? "快照有效 Token 走势" : "今日有效 Token 走势"} role="img"><polyline points={points} fill="none" vectorEffect="non-scaling-stroke" /></svg>;
}

export function LiveWallpaperView({ preview = false }: { preview?: boolean } = {}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 60_000); return () => window.clearInterval(timer); }, []);
  const [snapshot, setSnapshot] = useState<WallpaperStatsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requests = useRef(new Map<string, Promise<unknown>>());
  const generation = useRef(0);

  const loadStats = useCallback(async ({ resetSnapshot = false } = {}) => {
    const requestGeneration = ++generation.current;
    if (resetSnapshot) setSnapshot(null);
    setLoading(true);
    try {
      const settings = await invoke<AppSettings>('get_settings');
      const scope: DataScope = settings.wallpaper_use_cloud ? 'cloud' : 'local';
      const selection = scopeMachineSelection(scope, settings.wallpaper_device_filter);
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const query = normalizeStatsQuery({ range: 'today', timezone, machines: selection.machines, tools: [], models: [], search: null, tokenMode: 'effective' });
      const identity: WallpaperIdentity = { scope, deviceFilter: selection.deviceFilter, timezone, query };
      const key = JSON.stringify(identity);
      if (requestGeneration !== generation.current) return;
      setSnapshot((previous) => previous && JSON.stringify(previous.identity) !== key ? null : previous);
      let request = requests.current.get(key);
      if (!request) {
        request = invoke<unknown>('get_cached_stats', { scope, range: 'today', deviceFilter: selection.deviceFilter, timezone, machines: query.machines, tools: query.tools, models: query.models, search: query.search, tokenMode: query.tokenMode });
        requests.current.set(key, request);
        void request.finally(() => { if (requests.current.get(key) === request) requests.current.delete(key); }).catch(() => undefined);
      }
      const stats = parseStatsDataContract(await request);
      if (requestGeneration !== generation.current) return;
      if (!stats.meta?.query || !queryEchoMatches(stats.meta.query, query) || (stats.meta.timezone !== undefined && stats.meta.timezone !== timezone)) {
        throw new Error('统计响应与当前数据源或时区不一致');
      }
      setSnapshot({ stats, identity, loadedAt: new Date() });
      setError(null);
    } catch {
      if (requestGeneration !== generation.current) return;
      setError('统计读取失败，请稍后再试。');
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const install = (event: 'stats-updated' | 'settings-updated', callback: () => void) => {
      void listen(event, callback).then((unlisten) => { if (disposed) unlisten(); else { unlisteners.push(unlisten); visibleReconciler.request(); } }).catch(() => undefined);
    };
    const visibleReconciler = createVisibleStatsReconciler(() => document.visibilityState, () => { if (document.visibilityState === 'visible') void loadStats(); });
    install('stats-updated', () => visibleReconciler.request());
    install('settings-updated', () => { if (!disposed) void loadStats({ resetSnapshot: true }); });
    void loadStats();
    const interval = window.setInterval(() => visibleReconciler.request(), 5 * 60_000);
    document.addEventListener('visibilitychange', visibleReconciler.request);
    return () => { disposed = true; generation.current += 1; window.clearInterval(interval); document.removeEventListener('visibilitychange', visibleReconciler.request); visibleReconciler.cancel(); unlisteners.forEach((unlisten) => unlisten()); };
  }, [loadStats]);

  const presentation = useMemo(() => snapshot ? buildWallpaperSnapshot(snapshot.stats) : null, [snapshot]);
  const historical = snapshot ? isHistoricalWallpaperSnapshot(snapshot.stats, snapshot.identity.timezone, now) : false;
  const status = historical ? `历史快照 · ${formatSnapshotTime(snapshot?.stats.meta?.generatedAt, { year: 'numeric', month: 'numeric', day: 'numeric' })}` : null;
  const Container = preview ? 'div' : 'main';
  return <Container className={`live-wallpaper${preview ? ' live-wallpaper--preview' : ''}`} aria-live="polite"><section className="live-wallpaper__reading-layer">
    <Clock now={now} />
    {loading && !presentation ? <p className="live-wallpaper__status">正在读取今日统计</p> : null}
    {!loading && !presentation ? <p className="live-wallpaper__status">暂无可显示的今日统计</p> : null}
    {presentation ? <>
      {status ? <p className="live-wallpaper__history">{status}</p> : null}
      <section className="live-wallpaper__primary" aria-label={historical ? '历史有效 Token' : '今日有效 Token'}><p className="live-wallpaper__eyebrow">{historical ? '历史有效 Token' : '今日有效 Token'}</p><strong>{formatTokens(presentation.effectiveTokens)}</strong><p>输入 {formatTokens(presentation.inputTokens)} · 输出 {formatTokens(presentation.outputTokens)}</p></section>
      <dl className="live-wallpaper__facts"><div><dt>缓存</dt><dd>{formatTokens(presentation.cachedTokens)}</dd></div><div><dt>预估费用</dt><dd>{formatEstimatedUsd(presentation.cost)}</dd></div><div><dt>请求</dt><dd>{formatNum(presentation.requests)}</dd></div></dl>
      <section className="live-wallpaper__lower" aria-label={historical ? "快照趋势与工具排行" : "今日趋势与工具排行"}><div className="live-wallpaper__trend-block"><p className="live-wallpaper__eyebrow">{historical ? "快照走势" : "今日走势"}</p><Trend values={presentation.trend} historical={!!historical} /></div><div className="live-wallpaper__tools"><p className="live-wallpaper__eyebrow">工具排行</p>{presentation.tools.length === 0 ? <span className="live-wallpaper__muted">暂无工具记录</span> : <ol>{presentation.tools.map((tool) => <li key={tool.name}><span>{tool.name}</span><strong>{formatTokens(tool.effectiveTokens)}</strong></li>)}</ol>}</div></section>
      <p className="live-wallpaper__source">{snapshot?.identity.scope === 'cloud' ? '云端' : '本机'} · 数据生成于 {formatSnapshotTime(snapshot?.stats.meta?.generatedAt, { hour: '2-digit', minute: '2-digit' })} · 读取于 {snapshot?.loadedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</p>
    </> : null}
    {error ? <p className="live-wallpaper__error">{presentation ? '更新失败，正在显示最近可用数据。' : error}</p> : null}
  </section></Container>;
}
