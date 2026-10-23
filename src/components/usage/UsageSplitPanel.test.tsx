import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { StatsData } from '../../types';
import type { SplitDimension, SplitFocus, SplitMetric } from '../../utils/usageSplit';
import { UsageSplitPanel } from './UsageSplitPanel';

const stats = {
  summary: { totalTokens: 1000, inputTokens: 800, outputTokens: 200, cachedTokens: 0, totalCost: 3, totalRequests: 10, avgTokensPerReq: 100 },
  tools: {
    codex: { name: 'codex', input: 500, output: 100, cached: 0, total: 600, cost: 2, requests: 6, models: { 'gpt-5': 600 } },
    claude: { name: 'claude', input: 300, output: 100, cached: 0, total: 400, cost: 1, requests: 4, models: { sonnet: 400 } },
  },
  models: {
    'gpt-5': { name: 'gpt-5', total: 600, requests: 6, input: 500, output: 100, cost: 2 },
    sonnet: { name: 'sonnet', total: 400, requests: 4, input: 300, output: 100, cost: 1 },
  },
  trends: [], heatmap: {}, history: [],
} as unknown as StatsData;

function Harness({ onOpenEntity = vi.fn(), deviceAvailable = false }: { onOpenEntity?: (kind: 'tool' | 'model', id: string) => void; deviceAvailable?: boolean }) {
  const [dimension, setDimension] = useState<SplitDimension>('agent');
  const [metric, setMetric] = useState<SplitMetric>('tokens');
  const [focus, setFocus] = useState<SplitFocus | null>(null);
  return (
    <UsageSplitPanel stats={stats} dimension={dimension} metric={metric} focus={focus} deviceAvailable={deviceAvailable}
      onDimensionChange={setDimension} onMetricChange={setMetric} onFocusChange={setFocus} onOpenEntity={onOpenEntity} />
  );
}

const rowNames = () => [...screen.getByRole('list').querySelectorAll('.usage-split-name > span:last-child')]
  .map((name) => name.textContent);

describe('UsageSplitPanel', () => {
  it('点一行只看这一项，切到模型时列表随之收窄，只剩 Token 指标', () => {
    render(<Harness />);
    expect(rowNames()).toEqual(['codex', 'claude']);
    fireEvent.click(screen.getByRole('button', { name: /claude/, pressed: false }));
    expect(screen.getByRole('status')).toHaveTextContent('只看Agent claude');
    fireEvent.click(within(screen.getByRole('group', { name: '拆分维度' })).getByRole('button', { name: '模型' }));
    expect(rowNames()).toEqual(['sonnet']);
    expect(within(screen.getByRole('group', { name: '拆分指标' })).getByRole('button', { name: '费用' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '显示全部' }));
    expect(rowNames()).toEqual(['gpt-5', 'sonnet']);
  });

  it('指标切到费用后按费用显示；本机数据设备维度禁用并说明', () => {
    render(<Harness />);
    fireEvent.click(within(screen.getByRole('group', { name: '拆分指标' })).getByRole('button', { name: '费用' }));
    expect(screen.getByRole('list', { name: '按Agent拆分的费用排行' })).toBeInTheDocument();
    const device = within(screen.getByRole('group', { name: '拆分维度' })).getByRole('button', { name: '设备' });
    expect(device).toBeDisabled();
    expect(device).toHaveAttribute('title', expect.stringContaining('云端汇总'));
  });

  it('看板按钮打开原有专属看板', () => {
    const onOpenEntity = vi.fn();
    render(<Harness onOpenEntity={onOpenEntity} />);
    fireEvent.click(screen.getByRole('button', { name: '打开 codex 专属看板' }));
    expect(onOpenEntity).toHaveBeenCalledWith('tool', 'codex');
  });
});
