import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ModelStat } from '../types';
import { colorsForToolsInView, toolColorMap } from '../types';
import { useTheme } from '../utils/useTheme';
import { CostEfficiencyQuadrantPanel } from './CostEfficiencyQuadrantPanel';

interface CapturedPoint { itemStyle?: { color?: string; opacity?: number } }
interface CapturedOption { series?: Array<{ data?: CapturedPoint[] }> }
let lastOption: CapturedOption | null = null;

vi.mock('./EChart', () => ({
  EChart: ({ option }: { option: CapturedOption }) => {
    lastOption = option;
    return <div data-testid="distribution-chart" data-point-count={option.series?.[0]?.data?.length ?? 0} />;
  },
}));

vi.mock('../utils/useTheme', () => ({
  useTheme: vi.fn(() => ({ effective: 'dark' })),
}));

const models: ModelStat[] = [
  { name: 'model-a', tool: 'codex', input: 100, output: 50, cached: 0, total: 150, cost: 1, requests: 2 },
  { name: 'model-b', tool: 'claude', input: 300, output: 100, cached: 0, total: 400, cost: 3, requests: 8 },
];

function installMatchMedia(compact: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === '(max-width: 600px)' ? compact : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('CostEfficiencyQuadrantPanel responsive disclosure', () => {
  beforeEach(() => installMatchMedia(false));

  it('does not mount the chart runtime on compact screens and keeps a text summary', () => {
    installMatchMedia(true);
    render(<CostEfficiencyQuadrantPanel models={models} />);
    fireEvent.click(screen.getByRole('button', { name: /模型用量与费用分布/ }));
    expect(screen.queryByTestId('distribution-chart')).not.toBeInTheDocument();
    expect(screen.getByText(/窄屏隐藏坐标图/)).toBeInTheDocument();
    expect(screen.getByText(/文字摘要 = 本期均值分区/)).toBeInTheDocument();
    expect(screen.getByText(/文字分区只比较本期模型/)).toBeInTheDocument();
    expect(screen.queryByText(/圆点大小/)).not.toBeInTheDocument();
    expect(screen.getByText('model-a')).toBeInTheDocument();
  });

  it('mounts the chart only after desktop users expand the disclosure', () => {
    render(<CostEfficiencyQuadrantPanel models={models} />);
    expect(screen.queryByTestId('distribution-chart')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /模型用量与费用分布/ }));
    expect(screen.getByTestId('distribution-chart')).toHaveAttribute('data-point-count', '2');
  });

  it('plots every model it is given and says so, instead of a silent token top 8 (audit P0-2)', () => {
    const many: ModelStat[] = Array.from({ length: 11 }, (_, index) => ({
      name: `model-${index + 1}`,
      tool: 'codex',
      input: (11 - index) * 10_000,
      output: 0,
      cached: 0,
      total: (11 - index) * 10_000,
      // The smallest model by tokens is the most expensive one.
      cost: index === 10 ? 50 : 1 + index,
      requests: 3,
    }));
    render(<CostEfficiencyQuadrantPanel models={many} onModelClick={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /模型用量与费用分布/ }));
    expect(screen.getByTestId('distribution-chart')).toHaveAttribute('data-point-count', '11');
    expect(screen.getByText('本期 11 个模型全部进图。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /打开 model-11 专属看板/ })).toBeInTheDocument();
  });

  it('counts each excluded model by reason: missing split, unknown cost, no activity', () => {
    const mixed: ModelStat[] = [
      ...models,
      { name: 'no-split', tool: 'codex', cached: 10, total: 10, cost: 2, requests: 1 },
      { name: 'no-cost', tool: 'codex', input: 10, output: 5, cached: 0, total: 15, requests: 1 },
      { name: 'idle', tool: 'codex', input: 0, output: 0, cached: 40, total: 40, cost: 0, requests: 1 },
    ];
    render(<CostEfficiencyQuadrantPanel models={mixed} />);
    fireEvent.click(screen.getByRole('button', { name: /模型用量与费用分布/ }));
    expect(screen.getByTestId('distribution-chart')).toHaveAttribute('data-point-count', '2');
    expect(screen.getByText(
      '本期 5 个模型中 2 个进图；未纳入：1 个缺少输入/输出拆分，1 个预估费用不可得，1 个本期没有有效 Token 与费用。',
    )).toBeInTheDocument();
  });

  it('says why instead of vanishing when fewer than two models can be plotted (review P3-6)', () => {
    const sparse: ModelStat[] = [
      models[0],
      { name: 'no-split', tool: 'codex', cached: 10, total: 10, cost: 2, requests: 1 },
      { name: 'no-cost', tool: 'codex', input: 10, output: 5, cached: 0, total: 15, requests: 1 },
    ];
    const { rerender } = render(<CostEfficiencyQuadrantPanel models={sparse} />);
    expect(screen.getByRole('region', { name: '模型用量与费用分布' })).toBeInTheDocument();
    expect(screen.getByText('至少需要 2 个有预估费用和输入/输出拆分的模型，才能比较用量与预估费用。')).toBeInTheDocument();
    expect(screen.getByText('本期 3 个模型中只有 1 个可进图；未纳入：1 个缺少输入/输出拆分，1 个预估费用不可得。')).toBeInTheDocument();
    // Nothing to expand, and no chart runtime for a comparison that cannot exist.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('distribution-chart')).not.toBeInTheDocument();

    rerender(<CostEfficiencyQuadrantPanel models={sparse.slice(1)} />);
    expect(screen.getByText('本期 2 个模型都无法进图；未纳入：1 个缺少输入/输出拆分，1 个预估费用不可得。')).toBeInTheDocument();
  });

  it('renders nothing when there is no model at all', () => {
    const { container } = render(<CostEfficiencyQuadrantPanel models={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('uses the T10.154 names: 规模与费用, 高/低费用 zones, 预估费用（USD）axis and 单位费用 per million (D32–D37)', () => {
    const six: ModelStat[] = Array.from({ length: 6 }, (_, index) => ({
      name: `m-${index + 1}`,
      tool: 'codex',
      input: (index + 1) * 1_000_000,
      output: 0,
      cached: 0,
      total: (index + 1) * 1_000_000,
      cost: index + 1,
      requests: 2,
    }));
    render(<CostEfficiencyQuadrantPanel models={six} />);
    const disclosure = screen.getByRole('button', { name: /模型用量与费用分布/ });
    expect(disclosure).not.toHaveTextContent('规模与费用');
    expect(disclosure).toHaveTextContent('展开比较模型用量与预估费用');
    fireEvent.click(disclosure);
    const summary = screen.getByLabelText('模型用量与费用分区摘要');
    expect(summary).toHaveTextContent('高用量 · 高费用');
    expect(summary).toHaveTextContent('低用量 · 低费用');
    expect(summary).toHaveTextContent('6.00M · ≈$6.00');
    expect(screen.getByText('文字摘要仅列费用最高的前 5 个模型。')).toBeInTheDocument();

    const option = lastOption as unknown as {
      yAxis: { name: string };
      series: Array<{ name: string; data: Array<{ name: string; value: [number, number, number, ModelStat] }> }>;
      tooltip: { formatter: (params: { data: unknown }) => string };
    };
    expect(option.yAxis.name).toBe('预估费用（USD）');
    expect(option.series.map((series) => series.name)).toEqual(['模型', '用量均值线', '费用均值线']);
    const tooltip = option.tooltip.formatter({ data: option.series[0].data[0] });
    expect(tooltip).toContain('预估费用: <b');
    expect(tooltip).toContain('≈$6.00');
    // $6 ÷ 6M 有效 Token × 1M = $1.00 每百万 Token（原为每千 Token 的成本密度）。
    expect(tooltip).toContain('单位费用: ≈$1.00/百万 Token');
    expect(document.body.textContent + tooltip).not.toMatch(/成本|支出|\/1k/);
  });

  it('offers keyboard-accessible summary drilldowns instead of relying on canvas clicks', () => {
    const onModelClick = vi.fn();
    render(<CostEfficiencyQuadrantPanel models={models} onModelClick={onModelClick} />);
    fireEvent.click(screen.getByRole('button', { name: /模型用量与费用分布/ }));
    const modelButton = screen.getByRole('button', { name: /打开 model-a 专属看板/ });
    fireEvent.keyDown(modelButton, { key: 'Enter' });
    fireEvent.click(modelButton);
    expect(onModelClick).toHaveBeenCalledWith(models[0]);
  });
});

describe('CostEfficiencyQuadrantPanel tool colours (T10.178 review P1-1/P2-2)', () => {
  beforeEach(() => {
    installMatchMedia(false);
    (useTheme as unknown as Mock).mockReturnValue({ effective: 'dark' });
  });

  // antigravity and gemini both primary to chart-slot 1 (§3.8) — the exact
  // same-slot pair the independent review found colliding in this app's
  // default fixture once same-view collision-shift was missing here (P1-1).
  const colliding: ModelStat[] = [
    { name: 'gemini-2.5-pro', tool: 'antigravity', input: 500, output: 200, cached: 0, total: 700, cost: 4, requests: 5 },
    { name: 'gemini-2.5-flash', tool: 'gemini', input: 300, output: 100, cached: 0, total: 400, cost: 2, requests: 3 },
  ];

  function pointColors(): Array<string | undefined> {
    return (lastOption?.series?.[0]?.data || []).map((point) => point.itemStyle?.color);
  }

  it('colours two models whose tools collide on the same primary slot differently, resolved the same way as colorsForToolsInView', () => {
    render(<CostEfficiencyQuadrantPanel models={colliding} />);
    fireEvent.click(screen.getByRole('button', { name: /模型用量与费用分布/ }));
    // distribution.items ranks by cost desc, so antigravity (cost 4) is rank 0
    // and gemini (cost 2) is rank 1 — order-independent assertions below.
    const [antigravityColor, geminiColor] = colorsForToolsInView(['antigravity', 'gemini'], 'dark');
    const colors = pointColors();
    expect(colors).toContain(antigravityColor);
    expect(colors).toContain(geminiColor);
    expect(colors[0]).not.toBe(colors[1]);
  });

  it('uses a screen-wide toolColors assignment when the caller (DashboardTab) passes one', () => {
    const shared = toolColorMap(['codex', 'antigravity', 'gemini'], 'dark');
    render(<CostEfficiencyQuadrantPanel models={colliding} toolColors={shared} />);
    fireEvent.click(screen.getByRole('button', { name: /模型用量与费用分布/ }));
    const colors = pointColors();
    expect(colors).toContain(shared.get('antigravity'));
    expect(colors).toContain(shared.get('gemini'));
  });

  it('keeps points at opacity 0.88 in the dark theme (unchanged) but fully opaque in the light theme, where 0.88 drops several slots under 3:1 (review P2-2, root R-9)', () => {
    const { rerender } = render(<CostEfficiencyQuadrantPanel models={colliding} />);
    fireEvent.click(screen.getByRole('button', { name: /模型用量与费用分布/ }));
    expect(pointColors().length).toBeGreaterThan(0);
    for (const point of lastOption!.series![0].data!) expect(point.itemStyle?.opacity).toBe(0.88);

    (useTheme as unknown as Mock).mockReturnValue({ effective: 'light' });
    // A new `models` array reference forces this memo()-wrapped component to
    // actually re-render (same-reference props would let React.memo bail out
    // before the component body — and the new useTheme() mock value — ever runs).
    rerender(<CostEfficiencyQuadrantPanel models={[...colliding]} />);
    for (const point of lastOption!.series![0].data!) expect(point.itemStyle?.opacity).toBe(1);
  });
});
