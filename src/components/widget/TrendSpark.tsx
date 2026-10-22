import { useId, useLayoutEffect, useRef, useState } from 'react';
import { formatTokens } from '../../utils/format';
import { monotoneCubicPath, type CurvePoint } from '../../utils/monotoneCubic';
import type { CardTrend } from './cardModel';

/**
 * 74px 走势（T10.192，方案 §6.4）：本期实线 + 面积，上期同进度虚线，横轴刻度。
 * 曲线用单调三次（`utils/monotoneCubic.ts`），峰值不被画高、零值不被画成负数。
 *
 * 契约里的上期序列只到“同进度”（dashboard-stats-v2 §3），所以昨日虚线也只画到现在，
 * 不画视觉稿里的昨日全天：全天需要另一次查询，不在本任务范围。
 */

export const TREND_HEIGHT = 74;
/** 刻度占的高度；曲线区 = 74 − 16。 */
const AXIS_HEIGHT = 16;
/** 挂件内容区宽度（364 − 2 × 18）；量不到宽度（测试、首帧）时用它。 */
export const TREND_FALLBACK_WIDTH = 328;

export interface TrendGeometry {
  line: string;
  area: string;
  previous: string;
  end: CurvePoint;
  baseline: number;
}

const BUCKET_MS = { hour: 3_600_000, day: 86_400_000 } as const;

/**
 * 进行中的最后一桶画在“现在”，其余桶画在桶中点。进度取 comparison 窗口
 * （`currentEnd − currentStart`），读不到时退回桶中点。
 */
export function trendXs(trend: Pick<CardTrend, 'slots' | 'current' | 'bucket' | 'window'>, width: number): number[] {
  const count = trend.current.length;
  const xs = trend.current.map((_, index) => ((index + 0.5) / trend.slots) * width);
  const { currentStart, currentEnd } = trend.window;
  if (count === 0 || !currentStart || !currentEnd) return xs;
  const elapsed = (Date.parse(currentEnd) - Date.parse(currentStart)) / BUCKET_MS[trend.bucket];
  if (!Number.isFinite(elapsed) || elapsed <= 0) return xs;
  const previousX = count > 1 ? xs[count - 2] : 0;
  const bucketEnd = (count / trend.slots) * width;
  xs[count - 1] = Math.min(bucketEnd, Math.max(previousX + 0.5, (elapsed / trend.slots) * width));
  return xs;
}

/** 两条线共用同一个纵轴：最大值 × 1.08 顶格，上下各留 3px。全是 0 时返回 null（没有走势可画）。 */
export function trendGeometry(trend: CardTrend, xs: readonly number[]): TrendGeometry | null {
  if (trend.current.length < 2) return null;
  const peak = Math.max(...trend.current, ...trend.previous);
  if (!(peak > 0)) return null;
  const plot = TREND_HEIGHT - AXIS_HEIGHT;
  const max = peak * 1.08;
  const y = (value: number) => 3 + (plot - 6) * (1 - value / max);
  const current = trend.current.map((value, index) => ({ x: xs[index], y: y(value) }));
  const previous = trend.previous.slice(0, xs.length).map((value, index) => ({ x: xs[index], y: y(value) }));
  const line = monotoneCubicPath(current);
  const end = current[current.length - 1];
  const baseline = plot;
  return {
    line,
    area: `${line} L${end.x.toFixed(1)} ${baseline} L${current[0].x.toFixed(1)} ${baseline} Z`,
    previous: previous.length > 1 ? monotoneCubicPath(previous) : '',
    end,
    baseline,
  };
}

function peakLabel(trend: CardTrend): string | null {
  let best = -1;
  trend.current.forEach((value, index) => {
    if (best < 0 || value > trend.current[best]) best = index;
  });
  if (best < 0 || !(trend.current[best] > 0)) return null;
  const bucket = trend.labels[best] ?? '';
  const day = /^\d{4}-(\d{2})-(\d{2})$/.exec(bucket);
  const when = day ? `${Number(day[1])}月${Number(day[2])}日` : bucket;
  return `峰值 ${when} ${formatTokens(trend.current[best])}`;
}

/** 量内容区宽度（clientWidth 不受设置页预览的缩放影响），首帧与测试环境用 328。 */
function useContentWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(TREND_FALLBACK_WIDTH);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => {
      if (element.clientWidth > 0) setWidth(element.clientWidth);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function TrendSpark({ trend, rangeLabel, loading }: {
  trend: CardTrend | null;
  rangeLabel: string;
  loading: boolean;
}) {
  const [ref, width] = useContentWidth<HTMLDivElement>();
  const gradientId = `wl-trend-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const geometry = trend ? trendGeometry(trend, trendXs(trend, width)) : null;
  const plot = TREND_HEIGHT - AXIS_HEIGHT;
  if (!trend || !geometry) {
    return (
      <div ref={ref} className="wl-trend is-empty">
        <span>{loading ? '' : '这个范围还没有走势'}</span>
      </div>
    );
  }
  const peak = peakLabel(trend);
  const label = `${rangeLabel}有效 Token 走势：实线为${rangeLabel}，虚线为${trend.previousLabel}${peak ? `；${peak}` : ''}`;
  return (
    <div ref={ref} className="wl-trend">
      <svg width={width} height={TREND_HEIGHT} viewBox={`0 0 ${width} ${TREND_HEIGHT}`} role="img" aria-label={label} focusable="false">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop className="wl-trend-stop" offset="0" stopOpacity="0.26" />
            <stop className="wl-trend-stop" offset="1" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line className="wl-trend-grid" x1="0" y1={plot - 0.5} x2={width} y2={plot - 0.5} />
        {geometry.previous && <path className="wl-trend-prev" d={geometry.previous} />}
        <path className="wl-trend-area" d={geometry.area} fill={`url(#${gradientId})`} />
        <path className="wl-trend-line" d={geometry.line} />
        <circle className="wl-trend-dot" cx={geometry.end.x.toFixed(1)} cy={geometry.end.y.toFixed(1)} r="3.2" />
        {trend.ticks.map((tick) => (
          <text
            key={`${tick.label}-${tick.at}`}
            className="wl-trend-tick"
            x={(tick.at * width).toFixed(1)}
            y={TREND_HEIGHT - 2}
            textAnchor={tick.anchor}
          >
            {tick.label}
          </text>
        ))}
      </svg>
    </div>
  );
}
