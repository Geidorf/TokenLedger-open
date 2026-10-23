import { describe, expect, it } from 'vitest';
import type { StatsData } from '../types';
import { cacheHitRate, splitHeatmap, splitUsage } from './usageSplit';

const stats = {
  summary: { totalTokens: 1000, inputTokens: 800, outputTokens: 200, cachedTokens: 0, totalCost: 3, totalRequests: 10, avgTokensPerReq: 100 },
  tools: {
    codex: { name: 'codex', input: 500, output: 100, cached: 400, cacheRead: 400, total: 1000, cost: 2, requests: 6, models: { 'gpt-5': 500, 'gpt-5-mini': 100 }, heatmap: { '2026-10-01': 600 } },
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
});

describe('splitHeatmap', () => {
  it('焦点决定热力图；设备或缺实体热力图时返回 null', () => {
    expect(splitHeatmap(stats, null)).toBe(stats.heatmap);
    expect(splitHeatmap(stats, { dimension: 'agent', id: 'claude' })).toEqual({ '2026-10-02': 400 });
    expect(splitHeatmap(stats, { dimension: 'model', id: 'gpt-5' })).toEqual({ '2026-10-01': 500 });
    expect(splitHeatmap(stats, { dimension: 'model', id: 'gpt-5-mini' })).toBeNull();
    expect(splitHeatmap(stats, { dimension: 'device', id: 'mac' })).toBeNull();
  });
});

describe('cacheHitRate', () => {
  it('读写拆分不可证明时不可得', () => {
    expect(cacheHitRate(100, undefined)).toBeNull();
    expect(cacheHitRate(0, 0)).toBeNull();
    expect(cacheHitRate(100, 300)).toBe(0.75);
  });
});
