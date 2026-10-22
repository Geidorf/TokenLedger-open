import { describe, expect, it } from 'vitest';
import { computeUnitCostUsd, formatUnitCost, UNIT_COST_LABEL, UNIT_COST_UNAVAILABLE } from './unitCost';

describe('单位费用（T10.159，T10.154 术语）', () => {
  it('指标名是“单位费用”，不是“单位成本”', () => {
    expect(UNIT_COST_LABEL).toBe('单位费用');
    expect(UNIT_COST_UNAVAILABLE).toBe('不可得');
  });

  it('每百万有效 Token 的预估费用；费用未知或有效 Token 不是正数时算不出，不当作 0', () => {
    expect(computeUnitCostUsd(228.26, 15_360_000)).toBeCloseTo(14.8607, 3);
    expect(computeUnitCostUsd(0, 1_000)).toBe(0);
    expect(computeUnitCostUsd(null, 1_000)).toBeNull();
    expect(computeUnitCostUsd(undefined, 1_000)).toBeNull();
    expect(computeUnitCostUsd(Number.NaN, 1_000)).toBeNull();
    expect(computeUnitCostUsd(-1, 1_000)).toBeNull();
    expect(computeUnitCostUsd(1, 0)).toBeNull();
    expect(computeUnitCostUsd(1, -5)).toBeNull();
    expect(computeUnitCostUsd(1, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('显示：不可得、小于 $0.01 不舍入成 $0.00、其余带 ≈', () => {
    expect(formatUnitCost(null)).toBe('不可得');
    expect(formatUnitCost(undefined)).toBe('不可得');
    expect(formatUnitCost(Number.NaN)).toBe('不可得');
    expect(formatUnitCost(-0.5)).toBe('不可得');
    expect(formatUnitCost(0)).toBe('≈$0.00/百万 Token');
    expect(formatUnitCost(0.000001)).toBe('<$0.01/百万 Token');
    expect(formatUnitCost(0.0099)).toBe('<$0.01/百万 Token');
    expect(formatUnitCost(0.01)).toBe('≈$0.01/百万 Token');
    expect(formatUnitCost(14.8607)).toBe('≈$14.86/百万 Token');
    expect(formatUnitCost(1234.5)).toBe('≈$1,234.50/百万 Token');
  });

  it('两步组合：费用未知直接写“不可得”', () => {
    expect(formatUnitCost(computeUnitCostUsd(null, 1_000_000))).toBe('不可得');
    expect(formatUnitCost(computeUnitCostUsd(3, 1_000_000))).toBe('≈$3.00/百万 Token');
  });
});
