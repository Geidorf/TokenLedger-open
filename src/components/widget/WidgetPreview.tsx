import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { StatsData, ToolStat, UsageComparison } from '../../types';
import {
  WIDGET_LAYOUTS,
  WIDGET_RANGES,
  resolveWidgetTheme,
  type WidgetConfig,
  type WidgetRange,
  type WidgetSurface,
} from '../../utils/widgetConfig';
import { buildCardModel, widgetCardSize, WIDGET_CARD_WIDTH, type CardQuota, type CardQuotaItem, type CardTheme } from './cardModel';
import { LedgerCard } from './LedgerCard';
import { RoutingCard } from './RoutingCard';
import { TrayTopBar } from './WidgetChrome';
import '../../styles/widget.css';

/**
 * 设置页「桌面挂件」每张卡里的静态预览（T10.192，方案 §7 的 P12）。复用挂件的同一套卡片与板式，
 * 数据是固定的示例（与 T10.190 视觉稿同一组数），按这块挂件当前的板式、主题与默认范围、
 * 按 §6.4 的尺寸画出来；设置页窄时整体等比缩小。它不可聚焦、不可点，读屏只读图注。
 */

const SAMPLE_LOADED_AT = new Date(2026, 6, 15, 14, 31);

interface SampleSeries {
  kind: UsageComparison['window']['kind'];
  bucket: 'hour' | 'day';
  labels: string[];
  current: number[];
  previous: number[];
  start: string;
  end: string;
}

const HOUR_LABELS = Array.from({ length: 15 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`);

/** 示例走势（千 Token）：今日按小时到 14:30；本周周一到周三；本月 1–15 日。 */
const SAMPLE_SERIES: Record<WidgetRange, SampleSeries> = {
  today: {
    kind: 'dayOverDay',
    bucket: 'hour',
    labels: HOUR_LABELS,
    current: [0, 0, 0, 0, 0, 0, 0, 28, 100, 237, 306, 267, 90, 217, 144],
    previous: [20, 8, 0, 0, 0, 0, 0, 40, 120, 250, 280, 240, 120, 230, 184],
    start: '2026-07-15T00:00:00',
    end: '2026-07-15T14:30:00',
  },
  week: {
    kind: 'weekOverWeek',
    bucket: 'day',
    labels: ['2026-07-13', '2026-07-14', '2026-07-15'],
    current: [1620, 1954, 1389],
    previous: [1710, 1880, 1492],
    start: '2026-07-13T00:00:00',
    end: '2026-07-15T14:30:00',
  },
  month: {
    kind: 'monthOverMonth',
    bucket: 'day',
    labels: Array.from({ length: 15 }, (_, day) => `2026-07-${String(day + 1).padStart(2, '0')}`),
    current: [1210, 1480, 960, 420, 380, 1530, 1720, 1650, 1390, 1180, 510, 460, 1620, 1954, 1389],
    previous: [1300, 1420, 1100, 520, 300, 1480, 1600, 1710, 1500, 1260, 480, 390, 1710, 1880, 1492],
    start: '2026-07-01T00:00:00',
    end: '2026-07-15T14:30:00',
  },
};

/** 工具份额与视觉稿一致：Codex 44%、Claude 31%、Antigravity 15%、其余 10%。 */
const SAMPLE_TOOL_SHARES: Array<[string, number]> = [
  ['codex', 0.44], ['claude', 0.31], ['antigravity', 0.15], ['opencode', 0.06], ['minimax', 0.04],
];

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sampleSummary(effective: number): StatsData['summary'] {
  const inputTokens = Math.round(effective * 0.5925);
  return {
    totalTokens: effective,
    inputTokens,
    outputTokens: effective - inputTokens,
    cachedTokens: Math.round(effective * 0.318),
    totalCost: Math.round(effective * 0.00001299 * 100) / 100,
    totalRequests: Math.round(effective / 441.2),
    avgTokensPerReq: 441,
  };
}

export function sampleStats(range: WidgetRange): StatsData {
  const series = SAMPLE_SERIES[range];
  const current = sum(series.current) * 1_000;
  const previous = sum(series.previous) * 1_000;
  const summary = sampleSummary(current);
  const tools: Record<string, ToolStat> = {};
  for (const [name, share] of SAMPLE_TOOL_SHARES) {
    const effective = Math.round(current * share);
    tools[name] = { name, input: Math.round(effective * 0.6), output: effective - Math.round(effective * 0.6), cached: 0, total: effective, cost: 0, requests: 0 };
  }
  const toSeries = (values: readonly number[]) => values.map((value, index) => ({
    bucket: series.labels[index], tokens: value * 1_000, requests: 0, cost: 0,
  }));
  const comparison: UsageComparison = {
    window: {
      kind: series.kind,
      timezone: 'Asia/Shanghai',
      bucket: series.bucket,
      currentStart: series.start,
      currentEnd: series.end,
      previousStart: series.start,
      previousEnd: series.end,
      alignedThrough: '14:30',
    },
    current: { summary, series: toSeries(series.current) },
    previous: { summary: sampleSummary(previous), series: toSeries(series.previous) },
    delta: {
      tokens: { absolute: current - previous, percent: ((current - previous) / previous) * 100, direction: current >= previous ? 'up' : 'down' },
      requests: { absolute: 0, percent: 0, direction: 'flat' },
      cost: { absolute: 0, percent: 0, direction: 'flat' },
    },
  };
  return { summary, tools, models: {}, trends: [], heatmap: {}, history: [], comparison };
}

const MINUTE = 60_000;

/** 与视觉稿同一组额度：按吃紧程度排好，重置时间相对“现在”。 */
function sampleQuota(now: number): CardQuota {
  const rows: Array<[string, string, string, number, CardQuotaItem['level'], number]> = [
    ['Claude', '', '5 小时', 14, 'critical', 38],
    ['Codex', '', '每周', 36, 'warn', 4_260],
    ['Antigravity', 'Claude / GPT', '每周', 55, 'ok', 4_260],
    ['Claude', '', '7 天', 59, 'ok', 4_260],
    ['Codex', '', '5 小时', 62, 'ok', 119],
    ['Antigravity', 'Gemini', '每周', 68, 'ok', 4_260],
  ];
  return {
    kind: 'ready',
    items: rows.map(([provider, group, label, available, level, minutes], index) => ({
      key: `sample-${index}`,
      provider,
      group,
      label,
      window: group ? `${group} ${label}` : label,
      available,
      level,
      stale: false,
      resetsAt: new Date(now + minutes * MINUTE).toISOString(),
    })),
  };
}

const LIGHT_QUERY = '(prefers-color-scheme: light)';

/** 「跟随系统」按系统深浅色取（与挂件 `resolveWidgetTheme` 同一规则），不看主窗口自己的主题。 */
function usePrefersLight(): boolean {
  const [prefersLight, setPrefersLight] = useState(() => (
    typeof window.matchMedia === 'function' ? window.matchMedia(LIGHT_QUERY).matches : false
  ));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(LIGHT_QUERY);
    const update = () => setPrefersLight(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return prefersLight;
}

/** 设置页比 364px 窄时整张卡等比缩小；量不到宽度（测试、首帧）时按原尺寸。 */
function usePreviewScale<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => {
      const width = element.clientWidth;
      setScale(width > 0 ? Math.min(1, width / WIDGET_CARD_WIDTH) : 1);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, scale] as const;
}

export function WidgetPreview({ surface, config }: { surface: WidgetSurface; config: WidgetConfig }) {
  const prefersLight = usePrefersLight();
  const theme: CardTheme = resolveWidgetTheme(config.theme, prefersLight);
  const [now] = useState(() => Date.now());
  const model = useMemo(() => buildCardModel({
    range: config.range,
    stats: sampleStats(config.range),
    loadedAt: SAMPLE_LOADED_AT,
    error: '',
    quota: sampleQuota(now),
    theme,
  }), [config.range, now, theme]);
  const [frameRef, scale] = usePreviewScale<HTMLDivElement>();
  const size = widgetCardSize(surface, config.layout);
  const layoutLabel = WIDGET_LAYOUTS.find((item) => item.id === config.layout)?.label ?? '';
  const rangeLabel = WIDGET_RANGES.find((item) => item.id === config.range)?.label ?? '';
  return (
    <figure className="wl-preview">
      <div ref={frameRef} className="wl-preview-frame" style={{ height: Math.round(size.height * scale) }} aria-hidden="true" inert>
        <div
          className="widget-root is-preview"
          data-mode={surface}
          data-layout={config.layout}
          data-range={config.range}
          data-card-theme={theme}
          style={{ width: size.width, height: size.height, transform: scale < 1 ? `scale(${scale})` : undefined }}
        >
          {surface === 'popover' && (
            <TrayTopBar range={config.range} showRange={config.layout !== 'quota' && config.layout !== 'routing'} actions={null} staticPreview />
          )}
          {/* 实时路由没有可信的示例数据可画：预览只说明这块会显示什么，不放示意动画。 */}
          {config.layout === 'routing'
            ? <RoutingCard scene={null} loaded={false} />
            : <LedgerCard layout={config.layout} model={model} now={now} />}
        </div>
      </div>
      <figcaption className="wl-preview-caption">
        {`预览 · 示例数据（${layoutLabel} · ${theme === 'light' ? '浅色' : '深色'} · ${rangeLabel} · ${size.width}×${size.height}）`}
      </figcaption>
    </figure>
  );
}
