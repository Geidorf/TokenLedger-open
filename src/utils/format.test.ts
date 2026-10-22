import { describe, expect, it } from 'vitest';
import estimatedUsdCases from '../../fixtures/estimated-usd-format-v1/cases.json';
import tokenCases from '../../fixtures/token-format-v1/cases.json';
import {
  COST_UNAVAILABLE,
  formatEstimatedUsd,
  formatSignedPercent,
  formatSignedUsd,
  formatTokens,
  formatUsd,
  formatUsdApprox,
  formatUsdMagnitude,
  isKnownCost,
} from './format';

// 与 Rust 托盘（src-tauri/src/widget_window.rs 的 format_estimated_usd、format_tokens）共用的黄金用例（T10.191）：
// 同一输入两端必须写出同一串。用例描述的是这里的现行输出，改格式化规则要两端一起改、用例一起改。
describe('与 Rust 托盘共用的黄金用例（fixtures/estimated-usd-format-v1、fixtures/token-format-v1）', () => {
  it('用例覆盖方案点名的边界，删掉任何一条都会在这里红', () => {
    expect(estimatedUsdCases.cases.map((item) => item.input)).toEqual(expect.arrayContaining(
      [null, 'NaN', '0', '1e-9', '0.005', '0.00999', '1.005', '999.995', '1234.5', '1e6'],
    ));
    expect(tokenCases.cases.map((item) => item.input)).toEqual(expect.arrayContaining(
      [null, 999, 1_000, 999_499, 999_500, 999_999, 1_000_000, 999_999_999, 1_000_000_000],
    ));
  });

  // 金额输入写成十进制字符串，交给 Number() 正确舍入地解析；null 表示读不到。
  it.each(estimatedUsdCases.cases)('预估费用 $input → $expected', ({ input, expected }) => {
    expect(formatEstimatedUsd(input === null ? null : Number(input), 'summary')).toBe(expected);
  });

  it.each(tokenCases.cases)('Token $input → $expected', ({ input, expected }) => {
    expect(formatTokens(input)).toBe(expected);
  });
});

describe('formatTokens', () => {
  it('keeps grouped integers below 1K, one decimal for K and two for M', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1_000)).toBe('1.0K');
    expect(formatTokens(12_345)).toBe('12.3K');
    expect(formatTokens(1_234_567)).toBe('1.23M');
    expect(formatTokens(999_990_000)).toBe('999.99M');
  });

  it('uses B from one billion so cache-inclusive totals stay short (T10.161)', () => {
    expect(formatTokens(1_000_000_000)).toBe('1.00B');
    expect(formatTokens(3_456_780_000)).toBe('3.46B');
    expect(formatTokens(100_000_000_000)).toBe('100.00B');
  });

  it('moves to the next unit when rounding reaches 1000 of the current one', () => {
    expect(formatTokens(999_999)).toBe('1.00M');
    expect(formatTokens(999_999_999)).toBe('1.00B');
    expect(formatTokens(999.6)).toBe('1.0K');
  });

  it('abbreviates negative deltas by magnitude and keeps the sign', () => {
    expect(formatTokens(-500)).toBe('-500');
    expect(formatTokens(-12_345)).toBe('-12.3K');
    expect(formatTokens(-2_500_000_000)).toBe('-2.50B');
  });

  it('renders unknown input as “—”: never text built from Infinity/NaN, never a fake 0 (GLB-01)', () => {
    expect(formatTokens(Number.NaN)).toBe('—');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatTokens(Number.NEGATIVE_INFINITY)).toBe('—');
    expect(formatTokens(undefined)).toBe('—');
    expect(formatTokens(null)).toBe('—');
  });

  it('drops the sign below half a token instead of printing -0', () => {
    expect(formatTokens(-0.4)).toBe('0');
    expect(formatTokens(-0)).toBe('0');
    expect(formatTokens(-0.6)).toBe('-1');
    // T10.204：half a token rounds away from zero like any other tie, so -0.5
    // must not fall into `Math.round(-0.5) === -0` and print "-0".
    expect(formatTokens(-0.5)).toBe('-1');
  });

  it('rounds the K/M/B digit on the decimal value, not the binary float (T10.204)', () => {
    // 1,150 / 1,000 = 1.15 is not exactly representable in binary (it rounds
    // down to 1.1499...), so `.toFixed(1)` used to truncate this to 1.1K.
    expect(formatTokens(1_150)).toBe('1.2K');
    expect(formatTokens(-1_150)).toBe('-1.2K');
    // Same story one unit up: 1,005,000 / 1,000,000 = 1.005 rounds down in
    // binary, so `.toFixed(2)` used to truncate this to 1.00M.
    expect(formatTokens(1_005_000)).toBe('1.01M');
  });

  it('keeps B as the largest unit: no promotion past 1000.00B', () => {
    expect(formatTokens(999_994_999_999)).toBe('999.99B');
    expect(formatTokens(999_995_000_000)).toBe('1000.00B');
    expect(formatTokens(1e12)).toBe('1000.00B');
  });
});

describe('formatUsd', () => {
  it('keeps two decimals with thousands grouping (the .toFixed(2) replacements lacked separators)', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(3.45)).toBe('$3.45');
    expect(formatUsd(7.2)).toBe('$7.20');
    expect(formatUsd(999.996)).toBe('$1,000.00');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(128640.34)).toBe('$128,640.34');
  });

  it('is for axis ticks only: a tick is finite, so the $0.00 fallback never shows an unknown cost', () => {
    expect(formatUsd(Number.NaN)).toBe('$0.00');
    expect(formatUsd(Infinity)).toBe('$0.00');
    expect(formatUsd(12)).toBe('$12.00');
  });
});

describe('预估费用格式（T10.154 §4.1、§2.8，GLB-01）', () => {
  it('汇总金额：≈$、千分位、两位小数；0 < v < 0.01 写 <$0.01；真实 0 写 ≈$0.00', () => {
    expect(formatEstimatedUsd(1422.78)).toBe('≈$1,422.78');
    expect(formatEstimatedUsd(20.5, 'summary')).toBe('≈$20.50');
    expect(formatEstimatedUsd(0.01)).toBe('≈$0.01');
    expect(formatEstimatedUsd(0.0099)).toBe('<$0.01');
    expect(formatEstimatedUsd(0.0001)).toBe('<$0.01');
    expect(formatEstimatedUsd(0)).toBe('≈$0.00');
    expect(formatEstimatedUsd(-0)).toBe('≈$0.00');
  });

  it('单条记录：v < $1 保留 4 位，v ≥ $1 保留 2 位，不足 0.0001 写 <$0.0001', () => {
    expect(formatEstimatedUsd(0.0012, 'record')).toBe('≈$0.0012');
    expect(formatEstimatedUsd(0.12346, 'record')).toBe('≈$0.1235');
    expect(formatEstimatedUsd(1.25, 'record')).toBe('≈$1.25');
    expect(formatEstimatedUsd(1234.5, 'record')).toBe('≈$1,234.50');
    expect(formatEstimatedUsd(0.00001, 'record')).toBe('<$0.0001');
    expect(formatEstimatedUsd(0, 'record')).toBe('≈$0.00');
  });

  it('记录精度先舍入到 4 位再判断量级：0.99995 舍入后是 1.0000，应改用 2 位（T10.186 评审 P3-4）', () => {
    expect(formatEstimatedUsd(0.99995, 'record')).toBe('≈$1.00');
    expect(formatEstimatedUsd(0.99994, 'record')).toBe('≈$0.9999');
    expect(formatEstimatedUsd(0.999949, 'record')).toBe('≈$0.9999');
  });

  it.each([null, undefined, Number.NaN, Infinity, -Infinity, -0.5])('未知值 %s 写「不可得」，从不写 $0', (value) => {
    expect(formatEstimatedUsd(value)).toBe('不可得');
    expect(formatEstimatedUsd(value, 'record')).toBe('不可得');
    expect(formatUsdApprox(value)).toBe('不可得');
    expect(formatUsdMagnitude(value)).toBe('不可得');
    expect(isKnownCost(value)).toBe(false);
  });

  it('差值带正负号、不带 ≈，负号用 U+2212；0 写 $0.00；极小差值不写成 $0.00', () => {
    expect(formatSignedUsd(3.2)).toBe('+$3.20');
    expect(formatSignedUsd(-1.05)).toBe('−$1.05');
    expect(formatSignedUsd(-1234.5)).toBe('−$1,234.50');
    expect(formatSignedUsd(0)).toBe('$0.00');
    expect(formatSignedUsd(0.004)).toBe('+<$0.01');
    expect(formatSignedUsd(Number.NaN)).toBe('不可得');
    expect(formatSignedUsd(null)).toBe('不可得');
    expect(formatSignedUsd(-1.05)).not.toContain('-');
    expect(formatUsdMagnitude(3.2)).toBe('$3.20');
  });

  it('有符号百分比与 formatSignedUsd 共用同一套正负号规则，负号用 U+2212（T10.186 评审 P3-4）', () => {
    expect(formatSignedPercent(12.34)).toBe('+12.3%');
    expect(formatSignedPercent(-96.666666)).toBe('−96.7%');
    expect(formatSignedPercent(0)).toBe('0.0%');
    expect(formatSignedPercent(-0)).toBe('0.0%');
    expect(formatSignedPercent(Number.NaN)).toBe('不可得');
    expect(formatSignedPercent(null)).toBe('不可得');
    expect(formatSignedPercent(-12.3)).not.toContain('-');
    expect(formatSignedPercent(50, 0)).toBe('+50%');
  });

  it('舍入到 digits 位后才是 0 的极小值不带符号，不是「−0.0%」「+0.0%」（T10.197 评审 P3-5）', () => {
    // -0.01、0.01 在默认 1 位小数下都舍入成 0.0，之前按原始值的符号位判断，写成 −0.0%/+0.0%。
    expect(formatSignedPercent(-0.01)).toBe('0.0%');
    expect(formatSignedPercent(0.01)).toBe('0.0%');
    // digits=0 时 -0.4 舍入成 0，同样不该带负号。
    expect(formatSignedPercent(-0.4, 0)).toBe('0%');
    // 真正舍入后仍非零的负值不受影响，照样带 U+2212（sanity check，不因这次修复被过度纠正）。
    expect(formatSignedPercent(-0.05)).toBe('−0.1%');
  });

  it('旧名 formatUsdApprox 与汇总格式一致（已弃用，不再把未知画成 ≈$0.00）', () => {
    expect(formatUsdApprox(20.5)).toBe('≈$20.50');
    expect(formatUsdApprox(1234.5)).toBe('≈$1,234.50');
    expect(formatUsdApprox(undefined)).toBe(COST_UNAVAILABLE);
    expect(isKnownCost(0)).toBe(true);
  });
});
