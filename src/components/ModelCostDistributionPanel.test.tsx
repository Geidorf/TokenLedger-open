import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ModelStat } from '../types';
import unknownCostFixture from '../../fixtures/dashboard-stats-v2/unknown-cost-cache-provenance-v2.json';
import {
  ModelCostDistributionPanel,
  modelCostCoverageSummary,
  modelCostState,
} from './ModelCostDistributionPanel';

function model(name: string, input: number, output: number, cost: number | undefined): ModelStat {
  return { name, input, output, cached: 0, total: input + output, cost, requests: 10 };
}

// Eleven models. By effective tokens `opus-rare` is the smallest (11th), by
// cost it is the third most expensive: the model the old token top-8 cut
// dropped from the cost report and then called "unattributable".
const ELEVEN_MODELS: ModelStat[] = [
  model('codex-main', 380_000, 0, 96),
  model('sonnet-main', 284_000, 0, 64),
  model('gemini-pro', 194_000, 0, 36),
  model('minimax', 164_000, 0, 31),
  model('deepseek', 120_000, 0, 2.8),
  model('kimi', 96_000, 0, 5.4),
  model('qwen', 72_000, 0, 3.7),
  model('flash', 60_000, 0, 1.2),
  model('grok', 40_000, 0, 1.7),
  model('haiku', 30_000, 0, 1.5),
  model('opus-rare', 12_000, 0, 39),
];
const ELEVEN_TOTAL = ELEVEN_MODELS.reduce((sum, item) => sum + (item.cost ?? 0), 0);

function listedNames() {
  const list = screen.getByLabelText('按预估费用降序的模型费用列表');
  return [...list.querySelectorAll('.model-cost-row-btn .model-cost-name')].map((name) => name.textContent);
}

describe('ModelCostDistributionPanel (audit P0-2)', () => {
  it('把已知正费用、已知为 0 与不可得作为三种状态', () => {
    expect(modelCostState(2.5)).toBe('known');
    expect(modelCostState(0)).toBe('zero');
    expect(modelCostState(null)).toBe('unavailable');
    expect(modelCostCoverageSummary([
      { model: model('known', 1, 0, 2), cost: 2, costSharePercent: 100, effectiveTokens: 1, cacheReusePercent: 0, requests: 1 },
      { model: model('zero', 1, 0, 0), cost: 0, costSharePercent: 0, effectiveTokens: 1, cacheReusePercent: 0, requests: 1 },
      { model: model('unknown', 1, 0, undefined), cost: null, costSharePercent: null, effectiveTokens: 1, cacheReusePercent: 0, requests: 1 },
    ])).toEqual({ known: 1, zero: 1, unavailable: 1 });
  });

  it('ranks every model by cost, so a model ranked 11th by tokens appears in the default rows', () => {
    render(<ModelCostDistributionPanel models={ELEVEN_MODELS} totalCost={ELEVEN_TOTAL} />);
    const names = listedNames();
    expect(names).toHaveLength(8);
    expect(names.slice(0, 3)).toEqual(['codex-main', 'sonnet-main', 'opus-rare']);
    // The three cheapest models wait behind "展开全部" instead of disappearing.
    expect(names).not.toContain('flash');
    expect(screen.getByText('其余 3 个模型合计 ≈$4.40（1.6%）')).toBeInTheDocument();
  });

  it('never calls the cost of collapsed models unattributable', () => {
    render(<ModelCostDistributionPanel models={ELEVEN_MODELS} totalCost={ELEVEN_TOTAL} />);
    expect(screen.queryByText(/无法归属|缺少可归属/)).not.toBeInTheDocument();
  });

  it('expands to every model in place and collapses back', () => {
    render(<ModelCostDistributionPanel models={ELEVEN_MODELS} totalCost={ELEVEN_TOTAL} />);
    const toggle = screen.getByRole('button', { name: '展开全部（11）' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveClass('ghost-inline');
    fireEvent.click(toggle);
    expect(listedNames()).toHaveLength(11);
    expect(listedNames().slice(8)).toEqual(['grok', 'haiku', 'flash']);
    const collapse = screen.getByRole('button', { name: '收起' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    expect(collapse.getAttribute('aria-controls')).toBe(screen.getByLabelText('按预估费用降序的模型费用列表').id);
    fireEvent.click(collapse);
    expect(listedNames()).toHaveLength(8);
  });

  it('shows no toggle when eight or fewer models exist', () => {
    render(<ModelCostDistributionPanel models={ELEVEN_MODELS.slice(0, 8)} totalCost={240} />);
    expect(screen.queryByRole('button', { name: /展开全部/ })).not.toBeInTheDocument();
  });

  it('reports only cost that no model carries, and ignores sub-cent rounding', () => {
    const { rerender } = render(<ModelCostDistributionPanel models={ELEVEN_MODELS} totalCost={ELEVEN_TOTAL + 0.004} />);
    expect(screen.queryByText(/无法归属/)).not.toBeInTheDocument();
    rerender(<ModelCostDistributionPanel models={ELEVEN_MODELS} totalCost={ELEVEN_TOTAL + 2.5} />);
    expect(screen.getByText('另有 ≈$2.50 无法归属到具体模型。')).toBeInTheDocument();
  });

  it('shows unknown cost as 不可得, sorts it last and qualifies the remainder', () => {
    const models = [...ELEVEN_MODELS.slice(0, 3), model('mystery', 50_000, 0, undefined)];
    const known = 96 + 64 + 36;
    render(<ModelCostDistributionPanel models={models} totalCost={known + 7} />);
    const rows = listedNames();
    expect(rows[rows.length - 1]).toBe('mystery');
    expect(screen.getByText('不可得')).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
    expect(screen.getByText('另有 ≈$7.00 未能归属到已知费用的模型，可能来自 1 个预估费用不可得的模型。')).toBeInTheDocument();
    expect(screen.getByLabelText('模型费用完整性')).toHaveTextContent('费用不可得 1');
  });

  it('已知为 0 保留 $0 事实与实线空槽，不伪装成费用不可得', () => {
    const models = [model('positive', 10_000, 0, 2), model('known-zero', 8_000, 0, 0), model('unknown', 6_000, 0, undefined)];
    render(<ModelCostDistributionPanel models={models} totalCost={2} />);
    const rowOf = (name: string) => screen.getByText(name).closest('.model-cost-row-btn') as HTMLElement;
    const zero = rowOf('known-zero');
    expect(zero.querySelector('.model-cost-amount')).toHaveTextContent('已知为 0≈$0.00');
    expect(zero.querySelector('.model-cost-amount')).toHaveAttribute('aria-label', 'known-zero预估费用：已知为 0');
    expect(zero.querySelector('.model-cost-meter')).toHaveClass('is-zero');
    expect(zero.querySelector('.model-cost-meter')).not.toHaveClass('is-unavailable');
    const coverage = screen.getByLabelText('模型费用完整性');
    expect(coverage).toHaveTextContent('已知正费用 1');
    expect(coverage).toHaveTextContent('已知为 0 1');
    expect(coverage).toHaveTextContent('费用不可得 1');
  });

  it('固定 Stats v2 fixture 中的 1.50 已知合计、0 和 unknown 在排行中保持三种语义', () => {
    const models = Object.values(unknownCostFixture.models) as ModelStat[];
    render(<ModelCostDistributionPanel models={models} totalCost={unknownCostFixture.summary.totalCost} />);
    expect(listedNames()).toEqual([
      'explicit-split',
      'inconsistent-cache-split',
      'known-free',
      'unknown-cost-combined-cache',
    ]);
    const coverage = screen.getByLabelText('模型费用完整性');
    expect(coverage).toHaveTextContent('已知正费用 2');
    expect(coverage).toHaveTextContent('已知为 0 1');
    expect(coverage).toHaveTextContent('费用不可得 1');
    const zero = screen.getByText('known-free').closest('.model-cost-row-btn') as HTMLElement;
    const unknown = screen.getByText('unknown-cost-combined-cache').closest('.model-cost-row-btn') as HTMLElement;
    expect(zero.querySelector('.model-cost-amount')).toHaveTextContent('已知为 0≈$0.00');
    expect(unknown.querySelector('.model-cost-amount')).toHaveTextContent('不可得');
  });

  it('draws no bar and no cost rank for unknown cost, so it never reads as $0 (GLB-01)', () => {
    const models = [...ELEVEN_MODELS.slice(0, 3), model('mystery', 50_000, 0, undefined)];
    render(<ModelCostDistributionPanel models={models} totalCost={96 + 64 + 36} />);
    const rowOf = (name: string) => screen.getByText(name).closest('.model-cost-row-btn') as HTMLElement;
    const unknown = rowOf('mystery');
    expect(unknown.querySelector('.model-cost-meter')).toHaveClass('is-unavailable');
    expect(unknown.querySelector('.model-cost-meter-fill')).toBeNull();
    expect(unknown.querySelector('.model-cost-rank')).toHaveTextContent('—');
    expect(unknown.querySelector('.model-cost-amount')).toHaveTextContent('不可得');
    // Known rows keep their bar and a contiguous cost rank.
    const known = rowOf('gemini-pro');
    expect(known.querySelector('.model-cost-rank')).toHaveTextContent('3');
    expect(known.querySelector('.model-cost-meter')).not.toHaveClass('is-unavailable');
    expect((known.querySelector('.model-cost-meter-fill') as HTMLElement).style.width).toBe('37.5%');
  });

  it('uses the T10.154 names: 模型费用分布, ≈$ row amounts and 预估费用 in the drawer (D26–D30)', () => {
    render(<ModelCostDistributionPanel models={[...ELEVEN_MODELS.slice(0, 2), model('tiny', 1_000, 0, 0.004)]} totalCost={160.004} />);
    const panel = screen.getByRole('region', { name: '模型费用分布' });
    expect(panel).toHaveTextContent('模型费用分布');
    expect(panel).toHaveTextContent('按预估费用排序 · 不可得的排在最后 · 展开行查看缓存构成');
    const rowOf = (name: string) => screen.getByText(name).closest('.model-cost-row-btn') as HTMLElement;
    expect(rowOf('codex-main').querySelector('.model-cost-amount')).toHaveTextContent('预估费用≈$96.00');
    // 大于 0 但不到 1 美分的模型不再显示成 $0.00。
    expect(rowOf('tiny').querySelector('.model-cost-amount')).toHaveTextContent('<$0.01');
    fireEvent.click(rowOf('codex-main'));
    expect(screen.getByText(/codex-main · 预估费用 ≈\$96\.00 · 请求 10 次/)).toBeInTheDocument();
    expect(panel).not.toHaveTextContent(/成本|金额|未知费用/);
  });

  it('opens the model 专属看板 from the drill button', () => {
    const onModelClick = vi.fn();
    render(<ModelCostDistributionPanel models={ELEVEN_MODELS} totalCost={ELEVEN_TOTAL} onModelClick={onModelClick} />);
    fireEvent.click(screen.getByRole('button', { name: '打开 opus-rare 专属看板' }));
    expect(onModelClick).toHaveBeenCalledWith(ELEVEN_MODELS[10]);
  });
});
