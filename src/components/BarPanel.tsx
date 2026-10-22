import { BarChart3 } from 'lucide-react';
import { memo, useMemo, useRef } from 'react';
import { EChart } from './EChart';
import { formatAxisTokens, formatTokens } from '../utils/format';
import type { ModelStat } from '../types';
import { colorForTool, toolColorMap } from '../types';
import { toolDisplayName } from '../utils/toolDisplayName';
import { useTheme } from '../utils/useTheme';
import { escapeHtml } from '../utils/frontendContracts';
import { barSeriesStyle, getChartAnimation, getChartGrid, getChartThemeTokens, getChartTooltip } from '../utils/chartTheme';
import { BrandIcon } from './brand/BrandIcon';

interface BarPanelProps {
  topModels: ModelStat[];
  showTotalTokens: boolean;
  onModelClick?: (model: ModelStat) => void;
  /**
   * One tool -> colour assignment shared with every other tool-coloured panel
   * on the same screen (`DashboardTab` computes it once from `activeToolsList`
   * so a tool always reads the same colour in the tool strip, the donut and
   * this bar chart — T10.178 review P1-1). Falls back to a locally computed
   * assignment (still same-view collision-shifted, just not screen-wide) when
   * a caller does not have one yet, e.g. an isolated render in a test.
   */
  toolColors?: Map<string, string>;
}

const MODEL_LABEL_MAX = 18;

/** Horizontal bars read full-ish model names directly on the axis, so a
 * shorter clip (matching DeviceDistributionPanel's own ranked list) replaces
 * the old rotated vertical-axis labels entirely (5.5 图表规格). */
function truncateModelName(name: string): string {
  return name.length > MODEL_LABEL_MAX ? `${name.slice(0, MODEL_LABEL_MAX)}…` : name;
}

function BarPanelComponent({ topModels, showTotalTokens, onModelClick, toolColors }: BarPanelProps) {
  const { effective } = useTheme(); // Recompute CSS-token-backed chart options when the shared theme changes.
  const modelButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const t = getChartThemeTokens();
  const { textPrimary, textSecondary, textTertiary, borderFaint, borderStrong, primary } = t;
  const reduceMotion = t.reduceMotion;
  const labels = topModels.map((m) => truncateModelName(m.name));
  // Falls back to a locally rank-ordered assignment (topModels is already
  // sorted by displayed tokens desc) when no screen-wide map was passed in.
  const ownFallback = useMemo(
    () => toolColorMap(topModels.map((m) => m.tool || m.name), effective),
    [topModels, effective],
  );
  const colors = toolColors || ownFallback;
  // Light theme: draw the bar opaque (or nearly so) instead of fading to 0.74,
  // which drops several chart-slot colours under 3:1 on the white panel
  // (T10.178 review P2-2, root R-9). Dark theme keeps the existing fade.
  const alphaStops = effective === 'light' ? [1, 0.96] as const : [0.96, 0.74] as const;

  const option = {
    backgroundColor: 'transparent',
    ...getChartAnimation(reduceMotion),
    grid: getChartGrid({ left: 4, right: 50, top: 6, bottom: 4 }),
    xAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: borderFaint } },
      axisLabel: { color: textTertiary, formatter: (v: number) => formatAxisTokens(v) },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      // Horizontal bars: model identity lives on the category axis, so no
      // label ever needs to rotate (改前诊断 #4 / 5.5 图表规格).
      type: 'category',
      inverse: true,
      data: labels,
      axisLabel: { color: textSecondary, fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
      triggerEvent: true,
    },
    tooltip: getChartTooltip(t, {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: any) => {
        const item = params[0];
        const model = topModels[item.dataIndex];
        if (!model) return `${item.name}: <b>${formatTokens(item.value)}</b>`;
        const input = model.input || 0;
        const output = model.output || 0;
        const cached = model.cached || 0;
        const total = input + output + cached;
        const displayVal = showTotalTokens ? total : (input + output);
        const formatPct = (val: number) => total > 0 ? `${Math.round((val / total) * 100)}%` : '0%';
        return `
          <div style="font-size: 12px; line-height: 1.6;">
            <div style="font-weight: bold; margin-bottom: 4px;">${escapeHtml(model.name)}</div>
            <div style="color: ${textSecondary}; font-size: 11px;">所属工具: ${escapeHtml(model.tool ? toolDisplayName(model.tool) : '未知')}</div>
            <div>${showTotalTokens ? '总计 Tokens' : '有效 Token'}: <b>${formatTokens(displayVal)}</b></div>
            <div style="color: ${textSecondary}; margin-left: 8px; font-size: 11px;">输入: ${formatTokens(input)} (${formatPct(input)})</div>
            <div style="color: ${textSecondary}; margin-left: 8px; font-size: 11px;">输出: ${formatTokens(tooltipValOutput(model))} (${formatPct(output)})</div>
            <div style="color: ${textSecondary}; margin-left: 8px; font-size: 11px;">缓存: ${formatTokens(cached)} (${formatPct(cached)})</div>
            <div style="margin-top: 4px; border-top: 1px solid ${borderStrong}; padding-top: 4px; font-size: 10px; color: ${primary};">点击柱条或标签查看模型专属看板</div>
          </div>
        `;
      },
    }),
    series: [
      {
        type: 'bar',
        barMaxWidth: 22,
        itemStyle: { borderRadius: [0, 6, 6, 0] },
        data: topModels.map((m) => {
          const color = colors.get((m.tool || m.name).toLowerCase()) ?? colorForTool(m.tool || m.name, 0, effective);
          return {
            value: m.displayTotal ?? m.total,
            itemStyle: barSeriesStyle(color, 'horizontal', alphaStops).itemStyle,
          };
        }),
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowColor: 'rgba(0,0,0,0.2)',
            opacity: 1,
          },
        },
        label: {
          show: true,
          position: 'right',
          color: textPrimary,
          fontSize: 10,
          formatter: (p: { value: number }) => formatTokens(p.value),
        },
      },
    ],
  };

  function tooltipValOutput(model: ModelStat) {
    return model.output || 0;
  }

  const onEvents = {
    click: (params: any) => {
      let dataIndex = -1;
      if (params.componentType === 'series' && params.seriesType === 'bar') {
        dataIndex = params.dataIndex;
      } else if (params.componentType === 'yAxis' && params.value) {
        dataIndex = labels.findIndex((label) => label === params.value);
      }
      if (dataIndex >= 0) {
        const model = topModels[dataIndex];
        if (model && onModelClick) {
          modelButtons.current[dataIndex]?.focus();
          onModelClick(model);
        }
      }
    },
  };

  return (
    <section className="panel chart-panel model-ranking-panel">
      <div className="panel-title">
        <BarChart3 className="h-4 w-4 text-success" />
        模型排行
      </div>
      <div className="chart-fill">
        <EChart
          option={option}
          onEvents={onEvents}
          ariaLabel={`模型消耗排行，共 ${topModels.length} 个模型。下方列表可用键盘打开专属看板。`}
        />
      </div>
      <div className="chart-access-list" role="group" aria-label="可下钻的模型排行">
        {topModels.map((model, index) => (
          <button
            key={model.name}
            ref={(element) => { modelButtons.current[index] = element; }}
            type="button"
            onClick={() => onModelClick?.(model)}
            aria-label={`打开 ${model.name} 专属看板`}
            title={`打开 ${model.name} 专属看板`}
          >
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <BrandIcon name={model.tool || model.name} size={14} />
              <span className="truncate">{index + 1}. {model.name}</span>
            </span>
            <strong>{formatTokens(model.displayTotal ?? model.total)}</strong>
          </button>
        ))}
      </div>
    </section>
  );
}

export const BarPanel = memo(BarPanelComponent);

export default BarPanel;
