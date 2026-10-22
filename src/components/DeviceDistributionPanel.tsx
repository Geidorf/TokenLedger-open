import { memo } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { EChart } from './EChart';
import type { CompositionItem } from '../types';
import { formatAxisTokens, formatNum, formatTokens } from '../utils/format';
import { escapeHtml } from '../utils/frontendContracts';
import { useTheme } from '../utils/useTheme';
import { barSeriesStyle, CHART_GRID_CONTAIN_LABEL, getChartAnimation, getChartThemeTokens, getChartTooltip } from '../utils/chartTheme';

interface DeviceDistributionPanelProps {
  machines: CompositionItem[];
  showTotalTokens: boolean;
}

const MAX_VISIBLE_DEVICES = 8;

export function deviceDistributionValue(machine: CompositionItem, showTotalTokens: boolean) {
  const effective = Math.max(0, Number(machine.tokens) || 0);
  const cached = Math.max(0, Number(machine.cachedTokens) || 0);
  return showTotalTokens ? effective + cached : effective;
}

function DeviceDistributionPanelComponent({
  machines,
  showTotalTokens,
}: DeviceDistributionPanelProps) {
  useTheme();
  const t = getChartThemeTokens();
  const reduceMotion = t.reduceMotion;

  const sortedMachines = machines
    .map((machine, sourceIndex) => ({ machine, sourceIndex }))
    .filter(({ machine }) =>
      machine.value.trim() && deviceDistributionValue(machine, showTotalTokens) > 0)
    .sort((left, right) =>
      deviceDistributionValue(right.machine, showTotalTokens)
      - deviceDistributionValue(left.machine, showTotalTokens)
      || left.sourceIndex - right.sourceIndex)
    .map(({ machine }) => machine)
    .slice(0, MAX_VISIBLE_DEVICES);
  const total = machines.reduce(
    (sum, machine) => sum + deviceDistributionValue(machine, showTotalTokens),
    0,
  );
  const { textPrimary, textSecondary, textTertiary, borderFaint, borderStrong, primary } = t;

  const option = {
    backgroundColor: 'transparent',
    ...getChartAnimation(reduceMotion),
    grid: { left: 4, right: 52, top: 4, bottom: 4, ...CHART_GRID_CONTAIN_LABEL },
    xAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: borderFaint } },
      axisLabel: { color: textTertiary, formatter: (value: number) => formatAxisTokens(value) },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: sortedMachines.map((machine) =>
        machine.value.length > 18 ? `${machine.value.slice(0, 18)}…` : machine.value),
      axisLabel: { color: textSecondary, fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    tooltip: getChartTooltip(t, {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: Array<{ dataIndex: number; marker: string }>) => {
        const item = sortedMachines[params[0]?.dataIndex];
        if (!item) return '';
        const value = deviceDistributionValue(item, showTotalTokens);
        const percent = total > 0 ? (value / total) * 100 : 0;
        return `
          <div style="font-size: 12px; line-height: 1.6;">
            <div style="font-weight: 650; margin-bottom: 4px;">${params[0]?.marker || ''}${escapeHtml(item.value)}</div>
            <div>${showTotalTokens ? '总计 Tokens' : '有效 Token'}: <b>${formatTokens(value)}</b></div>
            <div style="color: ${textSecondary};">设备占比: ${percent.toFixed(percent >= 10 ? 1 : 2)}%</div>
            <div style="color: ${textSecondary};">记录数: ${formatNum(item.requests || 0)}</div>
            <div style="margin-top: 4px; border-top: 1px solid ${borderStrong}; padding-top: 4px; color: ${textTertiary};">
              输入 ${formatTokens(item.inputTokens || 0)} · 输出 ${formatTokens(item.outputTokens || 0)}
              ${showTotalTokens ? ` · 缓存 ${formatTokens(item.cachedTokens || 0)}` : ''}
            </div>
          </div>
        `;
      },
    }),
    series: [{
      type: 'bar',
      data: sortedMachines.map((machine) => deviceDistributionValue(machine, showTotalTokens)),
      barMaxWidth: 18,
      itemStyle: barSeriesStyle(primary, 'horizontal').itemStyle,
      label: {
        show: true,
        position: 'right',
        color: textPrimary,
        fontSize: 10,
        formatter: (params: { value: number }) => formatTokens(params.value),
      },
    }],
  };
  const ariaLabel = `云端设备分布，共 ${machines.length} 台设备。${sortedMachines
    .map((machine) => `${machine.value} ${formatTokens(deviceDistributionValue(machine, showTotalTokens))} Tokens`)
    .join('；')}`;

  return (
    <section className="panel chart-panel device-distribution-panel">
      <div className="panel-title">
        <MonitorSmartphone className="h-4 w-4 text-primary" />
        <span>设备分布</span>
        <span className="panel-title-meta">云端 · {machines.length} 台</span>
      </div>
      <div className="chart-fill">
        <EChart option={option} ariaLabel={ariaLabel} />
      </div>
      {machines.length > MAX_VISIBLE_DEVICES && (
        <p className="device-distribution-footnote">
          展示消耗最高的 {MAX_VISIBLE_DEVICES} 台设备
        </p>
      )}
    </section>
  );
}

export const DeviceDistributionPanel = memo(DeviceDistributionPanelComponent);

export default DeviceDistributionPanel;
