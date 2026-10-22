import { describe, expect, it } from 'vitest';
import type { ModelStat } from '../types';
import { modelCacheBreakdown, modelCostDistribution, splitModelCacheRead } from './modelDistribution';

function model(overrides: Partial<ModelStat> = {}): ModelStat {
  return { name: 'gpt-test', total: 1000, requests: 10, cost: 1.0, ...overrides };
}

describe('modelCostDistribution', () => {
  it('按预估成本降序并计算金额占比', () => {
    const rows = modelCostDistribution([
      model({ name: 'cheap', cost: 1, input: 100, output: 100 }),
      model({ name: 'expensive', cost: 9, input: 100, output: 100 }),
    ]);
    expect(rows.map((row) => row.model.name)).toEqual(['expensive', 'cheap']);
    expect(rows[0].costSharePercent).toBe(90);
    expect(rows[1].costSharePercent).toBe(10);
    expect(rows[0].effectiveTokens).toBe(200);
  });

  it('保留来源明确给出的真实零成本，不与未知成本混淆', () => {
    const rows = modelCostDistribution([
      model({ name: 'empty', total: 0, cost: 0, input: 0, output: 0, cached: 0 }),
      model({ name: 'real', cost: 2, input: 10, output: 20 }),
    ]);
    expect(rows.map((row) => row.model.name)).toEqual(['real', 'empty']);
    expect(rows[1].cost).toBe(0);
  });

  it('有效/全部口径共用同一份复用率', () => {
    const rows = modelCostDistribution([
      model({ name: 'm', cost: 1, input: 200, output: 50, cached: 1300, cacheRead: 800, cacheWrite: 500 }),
    ]);
    expect(rows[0].cacheReusePercent).toBe(80); // 800/(200+800)
  });

  it('保留未知成本并排在已知成本之后，不伪装成免费', () => {
    const rows = modelCostDistribution([
      model({ name: 'unknown', cost: undefined, input: 400, output: 100 }),
      model({ name: 'free', cost: 0, input: 200, output: 50 }),
      model({ name: 'known', cost: 2, input: 100, output: 50 }),
    ], 2);
    expect(rows.map((row) => row.model.name)).toEqual(['known', 'free', 'unknown']);
    expect(rows[1].cost).toBe(0);
    expect(rows[1].costSharePercent).toBe(0);
    expect(rows[2].cost).toBeNull();
    expect(rows[2].costSharePercent).toBeNull();
  });

  it('用汇总成本作分母，保留未归属金额而非把已知行重归一到 100%', () => {
    const rows = modelCostDistribution([
      model({ name: 'known', cost: 2, input: 100, output: 50 }),
    ], 10);
    expect(rows[0].costSharePercent).toBe(20);
  });
});

describe('modelCacheBreakdown', () => {
  it('有读写拆分时输出四段与复用率', () => {
    const breakdown = modelCacheBreakdown(
      model({ input: 200, output: 50, cached: 1300, cacheRead: 800, cacheWrite: 500 }),
    );
    expect(breakdown.hasReadWriteSplit).toBe(true);
    expect(breakdown.segments.map((segment) => segment.kind)).toEqual([
      'input', 'output', 'cacheRead', 'cacheWrite',
    ]);
    const cacheRead = breakdown.segments.find((segment) => segment.kind === 'cacheRead');
    expect(cacheRead?.tokens).toBe(800); // 1300 - 500
    expect(breakdown.reusePercent).toBe(80);
  });

  it('无读写拆分时降级为缓存合计', () => {
    const breakdown = modelCacheBreakdown(
      model({ input: 200, output: 50, cached: 1300 }),
    );
    expect(breakdown.hasReadWriteSplit).toBe(false);
    expect(breakdown.segments.map((segment) => segment.kind)).toEqual([
      'input', 'output', 'cacheCombined',
    ]);
    expect(breakdown.reusePercent).toBeNull();
  });
});

describe('splitModelCacheRead', () => {
  it('仅接受与 cached 完全一致的显式读写拆分', () => {
    expect(splitModelCacheRead({ cached: 1300, cacheRead: 800, cacheWrite: 500 })).toEqual({
      cacheRead: 800,
      cacheWrite: 500,
    });
  });

  it('任一侧缺失时返回 null，不从合计反推另一侧', () => {
    expect(splitModelCacheRead({ cached: 1300 })).toEqual({ cacheRead: null, cacheWrite: null });
    expect(splitModelCacheRead({ cached: 1300, cacheRead: 800 })).toEqual({ cacheRead: null, cacheWrite: null });
    expect(splitModelCacheRead({ cached: 1300, cacheWrite: 500 })).toEqual({ cacheRead: null, cacheWrite: null });
  });
});
