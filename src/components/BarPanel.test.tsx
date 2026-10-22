import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { ModelStat } from '../types';
import { colorsForToolsInView, toolColorMap } from '../types';
import { withAlpha } from '../utils/chartTheme';
import { useTheme } from '../utils/useTheme';
import { BarPanel } from './BarPanel';

vi.mock('../utils/useTheme', () => ({ useTheme: vi.fn(() => ({ effective: 'dark' })) }));

interface CapturedOption {
  series: Array<{
    data: Array<{ itemStyle?: { color?: { colorStops?: Array<{ offset: number; color: string }> } } }>;
  }>;
  tooltip: { formatter: (params: unknown) => string };
}

let lastOption: CapturedOption | null = null;

vi.mock('./EChart', () => ({
  EChart: ({ option }: { option: CapturedOption }) => {
    lastOption = option;
    return <div data-testid="bar-chart" />;
  },
}));

// antigravity and gemini both primary to chart-slot 1 (T10.178 §3.8) — the
// exact pair the independent review found rendered identically in this panel
// (crop-after-dark-dist-rank.png), because BarPanel called colorForTool per
// model instead of resolving the same-view collision shift once (P1-1).
const COLLIDING_MODELS: ModelStat[] = [
  { name: 'gemini-2.5-pro', tool: 'antigravity', input: 500, output: 200, cached: 0, total: 700, cost: 0.4, requests: 5 },
  { name: 'gemini-2.5-flash', tool: 'gemini', input: 300, output: 100, cached: 0, total: 400, cost: 0.2, requests: 3 },
  { name: 'gpt-5-codex', tool: 'codex', input: 100, output: 50, cached: 0, total: 150, cost: 0.1, requests: 2 },
];

function barColorAt(index: number): string | undefined {
  const stops = lastOption?.series[0]?.data[index]?.itemStyle?.color?.colorStops;
  return stops?.[0]?.color;
}

function renderPanel(models: ModelStat[], toolColors?: Map<string, string>) {
  return render(<BarPanel topModels={models} showTotalTokens={false} toolColors={toolColors} />);
}

describe('BarPanel tool colours (T10.178 review P1-1/P2-2)', () => {
  it('colours two models whose tools collide on the same primary slot differently, and matches ToolStrip/DonutPanel\'s own colorsForToolsInView for the same rank order', () => {
    renderPanel(COLLIDING_MODELS);
    const [antigravityColor, geminiColor, codexColor] = colorsForToolsInView(['antigravity', 'gemini', 'codex'], 'dark');
    // barColorAt reads the bar gradient's near-axis (0.96 alpha) stop; compare
    // against the same identity colour composited the same way, not the raw hex.
    expect(barColorAt(0)).toBe(withAlpha(antigravityColor, 0.96));
    expect(barColorAt(1)).toBe(withAlpha(geminiColor, 0.96));
    expect(barColorAt(2)).toBe(withAlpha(codexColor, 0.96));
    expect(barColorAt(0)).not.toBe(barColorAt(1));
  });

  it('several models that share one tool all read that tool\'s single (post-shift) colour back', () => {
    const models: ModelStat[] = [
      ...COLLIDING_MODELS,
      { name: 'gemini-2.5-nano', tool: 'gemini', input: 50, output: 10, cached: 0, total: 60, cost: 0.01, requests: 1 },
    ];
    renderPanel(models);
    expect(barColorAt(1)).toBe(barColorAt(3)); // both gemini models
  });

  it('uses a screen-wide toolColors assignment when the caller (DashboardTab) passes one, instead of recomputing its own from topModels\' order', () => {
    // A deliberately "wrong-looking" assignment (as if some other panel's
    // rank order had put codex first) — BarPanel must defer to it rather
    // than silently recomputing its own from COLLIDING_MODELS' order, or a
    // screen with several tool-coloured panels could disagree with itself.
    const shared = toolColorMap(['codex', 'antigravity', 'gemini'], 'dark');
    renderPanel(COLLIDING_MODELS, shared);
    expect(barColorAt(0)).toBe(withAlpha(shared.get('antigravity')!, 0.96));
    expect(barColorAt(1)).toBe(withAlpha(shared.get('gemini')!, 0.96));
    expect(barColorAt(2)).toBe(withAlpha(shared.get('codex')!, 0.96));
  });

  it('falls back to a locally computed same-view assignment when no screen-wide map is passed (e.g. an isolated render)', () => {
    renderPanel(COLLIDING_MODELS, undefined);
    expect(barColorAt(0)).not.toBe(barColorAt(1));
  });

  it('names the owning tool in the tooltip (review B1: colour is not the only cue distinguishing two same-slot tools)', () => {
    renderPanel(COLLIDING_MODELS);
    const html = lastOption!.tooltip.formatter([{ dataIndex: 1, value: 400 }]);
    expect(html).toContain('所属工具');
    expect(html).toContain('Gemini');
  });

  it('draws the bar gradient opaque-floored (0.96) in the light theme instead of fading to 0.74, which drops several chart slots under 3:1 (review P2-2, root R-9)', () => {
    (useTheme as unknown as Mock).mockReturnValue({ effective: 'light' });
    try {
      renderPanel(COLLIDING_MODELS);
      const stops = lastOption!.series[0].data[0].itemStyle!.color!.colorStops!;
      expect(stops.map((s) => s.offset)).toEqual([0, 1]);
      // withAlpha bakes the alpha into an rgba() string; both stops must come
      // from an alpha of at least 0.96, never the old 0.74 far-end.
      const alphaOf = (rgba: string) => Number(rgba.match(/[\d.]+(?=\))/)?.[0]);
      expect(alphaOf(stops[0].color)).toBeGreaterThanOrEqual(0.96);
      expect(alphaOf(stops[1].color)).toBeGreaterThanOrEqual(0.96);
    } finally {
      (useTheme as unknown as Mock).mockReturnValue({ effective: 'dark' });
    }
  });

  it('keeps the existing 0.96 -> 0.74 dark-theme gradient unchanged', () => {
    renderPanel(COLLIDING_MODELS);
    const stops = lastOption!.series[0].data[0].itemStyle!.color!.colorStops!;
    const alphaOf = (rgba: string) => Number(rgba.match(/[\d.]+(?=\))/)?.[0]);
    expect(alphaOf(stops[0].color)).toBeCloseTo(0.96, 5);
    expect(alphaOf(stops[1].color)).toBeCloseTo(0.74, 5);
  });
});


describe('T10.251 模型排行快捷入口可读性与操作', () => {
  it('入口换行后仍为可聚焦原生按钮，点击传完整模型和名称', () => {
    const models = Array.from({length: 8}, (_, index) => ({...COLLIDING_MODELS[0], name: `fixture-provider/team/long-model-${index}-context-1048576-tokens`}));
    const onModelClick = vi.fn();
    render(<BarPanel topModels={models} showTotalTokens={false} onModelClick={onModelClick} />);
    const buttons = within(screen.getByRole('group', {name: '可下钻的模型排行'})).getAllByRole('button');
    expect(buttons).toHaveLength(8);
    buttons.forEach((button, index) => {
      expect(button).toHaveAccessibleName(`打开 ${models[index].name} 专属看板`);
      expect(button.querySelector('span')).toHaveTextContent(models[index].name);
      expect(button.tabIndex).toBe(0);
      button.focus();
      expect(button).toHaveFocus();
      fireEvent.click(button);
      expect(onModelClick).toHaveBeenLastCalledWith(models[index]);
    });
  });
});
