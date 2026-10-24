import { describe, expect, it } from 'vitest';
import type { StatsData } from '../types';
import { accountSplitAvailable, cacheHitRate, effectiveSplitMetric, outputTokensPerSecond, splitHeatmapView, splitUsage } from './usageSplit';

const stats = {
  summary: { totalTokens: 1000, inputTokens: 800, outputTokens: 200, cachedTokens: 0, totalCost: 3, totalRequests: 10, avgTokensPerReq: 100 },
  tools: {
    codex: { name: 'codex', input: 500, output: 100, cached: 400, cacheRead: 400, cacheWrite: 0, total: 1000, cost: 2, requests: 6, models: { 'gpt-5': 500, 'gpt-5-mini': 100 }, heatmap: { '2026-10-01': 600 } },
    claude: { name: 'claude', input: 300, output: 100, cached: 0, total: 400, cost: 1, requests: 4, models: { sonnet: 400 }, heatmap: { '2026-10-02': 400 } },
  },
  models: {
    'gpt-5': { name: 'gpt-5', total: 500, requests: 4, input: 420, output: 80, cost: 1.5, cacheRead: 0, heatmap: { '2026-10-01': 500 } },
    'gpt-5-mini': { name: 'gpt-5-mini', total: 100, requests: 2, input: 80, output: 20, cost: 0.5 },
    sonnet: { name: 'sonnet', total: 400, requests: 4, input: 300, output: 100, cost: 1 },
  },
  trends: [],
  heatmap: { '2026-10-01': 600, '2026-10-02': 400 },
  history: [],
  machineDistribution: [
    { value: 'mac', tokens: 700, requests: 7, cost: 2 },
    { value: 'pc', tokens: 300, requests: 3, cost: 1 },
  ],
} as unknown as StatsData;

describe('splitUsage', () => {
  it('按 Agent 拆分有效 Token，缓存不并入，带占比与缓存命中率', () => {
    const { rows, metrics } = splitUsage(stats, 'agent', 'tokens', null);
    expect(rows.map((row) => [row.id, row.value])).toEqual([['codex', 600], ['claude', 400]]);
    expect(rows[0].share).toBeCloseTo(0.6);
    expect(rows[0].cacheHit).toBeCloseTo(400 / 900);
    expect(rows[1].cacheHit).toBeNull();
    expect(metrics).toEqual(['tokens', 'requests', 'cost']);
  });

  it('缓存读写拆分不可证明时不给命中率（与模型分布同一口径）', () => {
    const inconsistent = {
      ...stats,
      models: { odd: { name: 'odd', total: 100, requests: 1, input: 80, output: 20, cost: 0, cached: 100, cacheRead: 80, cacheWrite: 10 } },
    } as unknown as StatsData;
    expect(splitUsage(inconsistent, 'model', 'tokens', null).rows[0].cacheHit).toBeNull();
  });

  it('费用占比以同范围总费用为分母，未归属的费用不会把已知行放大', () => {
    const partial = { ...stats, summary: { ...stats.summary, totalCost: 10 } } as StatsData;
    const [top] = splitUsage(partial, 'agent', 'cost', null).rows;
    expect(top).toMatchObject({ id: 'codex', value: 2 });
    expect(top.share).toBeCloseTo(0.2);
  });

  it('指标切换改变排序', () => {
    expect(splitUsage(stats, 'model', 'requests', null).rows.map((row) => row.id)).toEqual(['gpt-5', 'sonnet', 'gpt-5-mini']);
    expect(splitUsage(stats, 'model', 'cost', null).rows[0]).toMatchObject({ id: 'gpt-5', value: 1.5 });
  });

  it('选中 Agent 后模型维度只剩它的模型，只有 Token 可得', () => {
    const result = splitUsage(stats, 'model', 'cost', { dimension: 'agent', id: 'codex' });
    expect(result.rows.map((row) => [row.id, row.value])).toEqual([['gpt-5', 500], ['gpt-5-mini', 100]]);
    expect(result.metrics).toEqual(['tokens']);
    expect(result.rows[0].requests).toBeNull();
    expect(result.rows[0].cost).toBeNull();
  });

  it('选中模型后 Agent 维度只剩用过它的 Agent', () => {
    const result = splitUsage(stats, 'agent', 'tokens', { dimension: 'model', id: 'sonnet' });
    expect(result.rows.map((row) => row.id)).toEqual(['claude']);
  });

  it('设备不能与 Agent、模型交叉：列表不收窄并标明', () => {
    expect(splitUsage(stats, 'device', 'tokens', { dimension: 'agent', id: 'codex' })).toMatchObject({ focusIgnored: true });
    const byAgent = splitUsage(stats, 'agent', 'tokens', { dimension: 'device', id: 'mac' });
    expect(byAgent.focusIgnored).toBe(true);
    expect(byAgent.rows).toHaveLength(2);
  });

  it('同一维度内的焦点不收窄列表', () => {
    expect(splitUsage(stats, 'agent', 'tokens', { dimension: 'agent', id: 'codex' }).rows).toHaveLength(2);
  });

  it('账号按网关供应商拆分，三项指标都可得；不与其他维度交叉', () => {
    const local = {
      ...stats,
      providers: {
        openai: { name: 'openai', input: 200, output: 80, cached: 0, total: 280, cost: 0.8, requests: 1, heatmap: { '2026-10-01': 280 } },
        relay: { name: 'relay', input: 30, output: 10, cached: 0, total: 40, cost: 0.1, requests: 1 },
      },
    } as unknown as StatsData;
    expect(accountSplitAvailable(stats)).toBe(false);
    expect(accountSplitAvailable(local)).toBe(true);
    const byAccount = splitUsage(local, 'account', 'requests', null);
    expect(byAccount.metrics).toEqual(['tokens', 'requests', 'cost']);
    expect(byAccount.rows.map((row) => [row.id, row.value])).toEqual([['openai', 1], ['relay', 1]]);
    expect(splitUsage(local, 'account', 'tokens', { dimension: 'agent', id: 'codex' }).focusIgnored).toBe(true);
    const byAgent = splitUsage(local, 'agent', 'tokens', { dimension: 'account', id: 'openai' });
    expect(byAgent.focusIgnored).toBe(true);
    expect(byAgent.rows).toHaveLength(2);
    expect(splitHeatmapView(local, { dimension: 'account', id: 'openai' }, 'tokens')).toMatchObject({ heatmap: { '2026-10-01': 280 }, focused: true });
    expect(splitHeatmapView(local, { dimension: 'account', id: 'relay' }, 'tokens').focused).toBe(false);
  });
});

describe('splitHeatmapView', () => {
  it('焦点决定热力图；设备或缺实体热力图时画整体', () => {
    expect(splitHeatmapView(stats, null, 'tokens')).toEqual({ heatmap: stats.heatmap, metric: 'tokens', focused: false, metricFallback: false });
    expect(splitHeatmapView(stats, { dimension: 'agent', id: 'claude' }, 'tokens').heatmap).toEqual({ '2026-10-02': 400 });
    expect(splitHeatmapView(stats, { dimension: 'model', id: 'gpt-5' }, 'tokens').heatmap).toEqual({ '2026-10-01': 500 });
    const noEntityHeatmap = splitHeatmapView(stats, { dimension: 'model', id: 'gpt-5-mini' }, 'tokens');
    expect(noEntityHeatmap.focused).toBe(false);
    expect(noEntityHeatmap.heatmap).toBe(stats.heatmap);
    expect(splitHeatmapView(stats, { dimension: 'device', id: 'mac' }, 'tokens').focused).toBe(false);
  });

  it('指标跟随拆分：有逐日记录数与费用时画它们，没有时退回 Token 并标明', () => {
    const local = {
      ...stats,
      heatmapRequests: { '2026-10-01': 6 },
      heatmapCost: { '2026-10-01': 2 },
      tools: { ...stats.tools, codex: { ...stats.tools.codex, heatmapRequests: { '2026-10-01': 6 }, heatmapCost: { '2026-10-01': 2 } } },
    };
    expect(splitHeatmapView(local, null, 'requests')).toEqual({ heatmap: { '2026-10-01': 6 }, metric: 'requests', focused: false, metricFallback: false });
    expect(splitHeatmapView(local, { dimension: 'agent', id: 'codex' }, 'cost')).toEqual({ heatmap: { '2026-10-01': 2 }, metric: 'cost', focused: true, metricFallback: false });
    expect(splitHeatmapView(local, { dimension: 'agent', id: 'claude' }, 'cost')).toEqual({ heatmap: { '2026-10-02': 400 }, metric: 'tokens', focused: true, metricFallback: true });
    expect(splitHeatmapView(stats, null, 'requests')).toEqual({ heatmap: stats.heatmap, metric: 'tokens', focused: false, metricFallback: true });
  });
});

describe('effectiveSplitMetric', () => {
  it('Agent × 模型交叉时面板只能显示 Token，热力图随之退回 Token', () => {
    expect(effectiveSplitMetric(stats, 'model', 'cost', { dimension: 'agent', id: 'codex' })).toBe('tokens');
    expect(effectiveSplitMetric(stats, 'model', 'cost', null)).toBe('cost');
    expect(effectiveSplitMetric(stats, 'agent', 'requests', { dimension: 'agent', id: 'codex' })).toBe('requests');
  });
});

describe('cacheHitRate', () => {
  it('读写拆分不可证明时不可得', () => {
    expect(cacheHitRate(100, undefined)).toBeNull();
    expect(cacheHitRate(0, 0)).toBeNull();
    expect(cacheHitRate(100, 300)).toBe(0.75);
  });
});

describe('outputTokensPerSecond', () => {
  it('没有耗时或没有输出时不可得', () => {
    expect(outputTokensPerSecond(100, undefined)).toBeNull();
    expect(outputTokensPerSecond(100, 0)).toBeNull();
    expect(outputTokensPerSecond(0, 1000)).toBeNull();
    expect(outputTokensPerSecond(300, 1500)).toBe(200);
  });
});
