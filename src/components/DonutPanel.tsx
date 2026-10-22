import { memo, useEffect, useRef, useState } from 'react';
import { PieChart } from 'lucide-react';
import { EChart } from './EChart';
import { formatTokens } from '../utils/format';
import type { ToolStat } from '../types';
import { colorsForToolsInView, effectiveTokens } from '../types';
import { useTheme } from '../utils/useTheme';
import { escapeHtml } from '../utils/frontendContracts';
import { toolDisplayName } from '../utils/toolDisplayName';
import { getChartThemeTokens, getChartTooltip, getChartEmphasisShadow, getChartAnimation } from '../utils/chartTheme';

interface DonutPanelProps {
  activeTools: ToolStat[];
  showTotalTokens: boolean;
}

export function describeToolDistribution(
  activeTools: readonly ToolStat[],
  showTotalTokens: boolean,
): string {
  const getValue = (tool: ToolStat) => (
    showTotalTokens
      ? (tool.input || 0) + (tool.output || 0) + (tool.cached || 0)
      : effectiveTokens(tool)
  );
  const total = activeTools.reduce((sum, tool) => sum + getValue(tool), 0);
  if (activeTools.length === 0 || total <= 0) {
    return `工具分布：暂无${showTotalTokens ? '总 Token' : '有效 Token'} 数据。`;
  }
  const metric = showTotalTokens ? '总 Token（含缓存）' : '有效 Token';
  const details = activeTools.map((tool) => {
    const value = getValue(tool);
    const percent = Math.round((value / total) * 100);
    return `${toolDisplayName(tool.name)}：${formatTokens(value)} ${metric}，占 ${percent}%`;
  });
  return `工具分布，共 ${activeTools.length} 个工具。${details.join('；')}。`;
}

function DonutPanelComponent({ activeTools, showTotalTokens }: DonutPanelProps) {
  const { effective } = useTheme(); // Recompute CSS-token-backed chart options when the shared theme changes.
  const panelRef = useRef<HTMLElement>(null);
  const [hideLegend, setHideLegend] = useState(false);
  const t = getChartThemeTokens();
  const reduceMotion = t.reduceMotion;

  useEffect(() => {
    const update = () => {
      const width = panelRef.current?.getBoundingClientRect().width || window.innerWidth;
      setHideLegend(width < 340);
    };
    update();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (panelRef.current && observer) observer.observe(panelRef.current);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  const getToolValue = (tool: ToolStat) => {
    return showTotalTokens
      ? (tool.input || 0) + (tool.output || 0) + (tool.cached || 0)
      : effectiveTokens(tool);
  };

  const totalVal = activeTools.reduce((s, t) => s + getToolValue(t), 0);
  const ariaLabel = describeToolDistribution(activeTools, showTotalTokens);

  // activeTools is already rank-ordered (useStats sorts by displayed tokens
  // desc); resolve same-slot collisions once by that rank and reuse the exact
  // same colours for the donut wedges and the compact legend below (T10.178).
  const toolColors = colorsForToolsInView(activeTools.map((tool) => tool.name), effective);

  const data = activeTools.map((tool, index) => ({
    name: tool.name,
    value: getToolValue(tool),
    itemStyle: { color: toolColors[index] },
  }));

  const { textPrimary, textSecondary, textTertiary } = t;

  const legend = hideLegend
    ? { show: false }
    : {
        orient: 'vertical',
        right: 0,
        top: 'center',
        itemWidth: 10,
        itemHeight: 10,
        textStyle: {
          color: textSecondary,
          fontSize: 11,
          rich: {
            val: { color: textPrimary, fontSize: 11, width: 54, align: 'right' },
            pct: { color: textTertiary, fontSize: 11, width: 34, align: 'right' },
          },
        },
        formatter: (name: string) => {
          const tool = activeTools.find((t2) => t2.name === name);
          const label = toolDisplayName(name);
          if (!tool) return label;
          const value = getToolValue(tool);
          const pct = totalVal > 0 ? Math.round((value / totalVal) * 100) : 0;
          return `${label}{val|${formatTokens(value)}}{pct|${pct}%}`;
        },
      };

  const option = {
    backgroundColor: 'transparent',
    ...getChartAnimation(reduceMotion),
    tooltip: getChartTooltip(t, {
      trigger: 'item',
      formatter: (params: { marker: string; name: string; value: number }) => {
        const tool = activeTools.find((t2) => t2.name === params.name);
        const label = escapeHtml(toolDisplayName(params.name));
        if (!tool) return `${params.marker}${label}: <b>${formatTokens(params.value)}</b>`;
        const total = (tool.input || 0) + (tool.output || 0) + (tool.cached || 0);
        const formatPct = (val: number) => total > 0 ? `${Math.round((val / total) * 100)}%` : '0%';
        return `
          <div style="font-size: 12px; line-height: 1.6;">
            <div style="font-weight: bold; margin-bottom: 4px;">${params.marker}${label}</div>
            <div>${showTotalTokens ? '总' : '有效'} Tokens: <b>${formatTokens(params.value)}</b></div>
            <div style="color: ${textSecondary}; margin-left: 8px; font-size: 11px;">输入: ${formatTokens(tool.input)} (${formatPct(tool.input)})</div>
            <div style="color: ${textSecondary}; margin-left: 8px; font-size: 11px;">输出: ${formatTokens(tool.output)} (${formatPct(tool.output)})</div>
            <div style="color: ${textSecondary}; margin-left: 8px; font-size: 11px;">缓存: ${formatTokens(tool.cached)} (${formatPct(tool.cached)})</div>
          </div>
        `;
      },
      animationDuration: 600,
      animationEasing: 'cubicOut',
    }),
    legend,
    series: [
      {
        type: 'pie',
        // Thinner ring (5.5 图表规格): wider inner radius than the previous
        // ~24% band, with rounded segment ends and a visible panel-colored
        // gap between segments via the border.
        radius: hideLegend ? ['62%', '80%'] : ['62%', '78%'],
        center: hideLegend ? ['50%', '54%'] : ['30%', '52%'],
        itemStyle: {
          borderRadius: 8,
          borderColor: t.bgPanel,
          borderWidth: 3,
        },
        emphasis: {
          scale: true,
          scaleSize: 5,
          itemStyle: getChartEmphasisShadow(),
        },
        label: { show: false },
        labelLine: { show: false },
        data,
      },
    ],
  };

  const compactLegend = hideLegend && activeTools.length > 0 && totalVal > 0;

  return (
    <section className={`panel chart-panel tool-distribution-panel${compactLegend ? ' is-compact' : ''}`} ref={panelRef}>
      <div className="panel-title">
        <PieChart className="h-4 w-4 text-primary" />
        工具分布
      </div>
      <div className="chart-fill">
        <EChart option={option} ariaLabel={ariaLabel} />
        {totalVal > 0 && (
          <div className={`donut-center-label${hideLegend ? ' is-centered' : ''}`} aria-hidden="true">
            <strong>{formatTokens(totalVal)}</strong>
            <span>{showTotalTokens ? '总 Token' : '有效 Token'}</span>
          </div>
        )}
      </div>
      {compactLegend && (
        <ul className="tool-distribution-legend" aria-label="工具分布明细">
          {activeTools.map((tool, index) => {
            const value = getToolValue(tool);
            const percent = Math.round((value / totalVal) * 100);
            return (
              <li key={tool.name}>
                <span
                  className="tool-distribution-swatch"
                  style={{ backgroundColor: toolColors[index] }}
                  aria-hidden="true"
                />
                <span className="tool-distribution-name">{toolDisplayName(tool.name)}</span>
                <strong className="tool-distribution-value">{formatTokens(value)}</strong>
                <span className="tool-distribution-percent">{percent}%</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export const DonutPanel = memo(DonutPanelComponent);

export default DonutPanel;
