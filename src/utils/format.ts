// Shared formatting helpers. These are intentionally tiny and side-effect
// free so they can be imported from any component without dragging in
// React or chart code.

const ZH_NUMBER = new Intl.NumberFormat('zh-CN');

export function formatNum(num: number): string {
  return ZH_NUMBER.format(Math.round(num || 0));
}

// USD with fixed 2 decimals and thousands grouping ($1,234.57). Kept beside
// formatNum so currency formatting lives in one place instead of being
// re-derived with `.toFixed(2)` at every call site (which dropped grouping
// separators for four-figure costs).
const USD = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Axis ticks only (T10.154 §4.1): `$12`, no `≈`. A tick is always a finite
 * number, so the `$0.00` fallback never stands in for an unknown cost; every
 * amount a reader sees goes through `formatEstimatedUsd` or `formatSignedUsd`.
 */
export function formatUsd(value: number): string {
  return `$${USD.format(Number.isFinite(value) ? value : 0)}`;
}

// 预估费用的通用格式（T10.154 §4.1、§2.8；GLB-01）：输入可以是 number | null | undefined。
// 缺失、非有限或为负都是「不可得」，绝不画成 $0.00；真实 0 显示 ≈$0.00。
export const COST_UNAVAILABLE = '不可得';

const USD_RECORD = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

/** 可以当作已知费用展示的值：有限且不为负。 */
export function isKnownCost(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * 预估费用：`summary`（KPI、汇总条、排行、海报、简报、挂件）写 `≈$1,422.78`，0 < v < 0.01 写 `<$0.01`；
 * `record`（明细单条记录）v < $1 保留 4 位（`≈$0.0012`，不足 0.0001 写 `<$0.0001`），v ≥ $1 保留 2 位。
 * 已知为 0 都写 `≈$0.00`；未知写「不可得」。
 */
export function formatEstimatedUsd(value: number | null | undefined, kind: 'summary' | 'record' = 'summary'): string {
  if (!isKnownCost(value)) return COST_UNAVAILABLE;
  if (value === 0) return '≈$0.00';
  if (kind === 'record' && value < 1) {
    if (value < 0.00005) return '<$0.0001';
    // 先舍入到 4 位，结果 ≥ 1 时改用 2 位（T10.186 评审 P3-4）：0.99995 舍入后是 1.0000，
    // 应显示 ≈$1.00 而不是 ≈$1.0000。
    const rounded4 = USD_RECORD.format(value);
    return Number(rounded4) >= 1 ? `≈$${USD.format(Number(rounded4))}` : `≈$${rounded4}`;
  }
  return value < 0.01 ? '<$0.01' : `≈$${USD.format(value)}`;
}

/** 差值的绝对值部分，正负号由调用方加（`describeMetricChange`）：`$3.20`、`<$0.01`，不带 ≈。 */
export function formatUsdMagnitude(value: number | null | undefined): string {
  if (!isKnownCost(value)) return COST_UNAVAILABLE;
  if (value === 0) return '$0.00';
  return value < 0.01 ? '<$0.01' : `$${USD.format(value)}`;
}

/** 差值：带正负号、不带 ≈，负号用 U+2212（`+$3.20`、`−$1.05`）；0 写 `$0.00`，未知写「不可得」。 */
export function formatSignedUsd(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return COST_UNAVAILABLE;
  if (value === 0) return '$0.00';
  return `${value > 0 ? '+' : '−'}${formatUsdMagnitude(Math.abs(value))}`;
}

/**
 * 有符号百分比：与 `formatSignedUsd` 共用同一套正负号规则，负号用 U+2212，不用 ASCII 连字符
 * （T10.186 评审 P3-4：趋势 tooltip 里金额已经是 U+2212，百分比却还是 `toFixed` 的 ASCII `-`）。
 * 0 不带符号；未知写「不可得」。`digits` 默认保留 1 位小数。舍入到 `digits` 位后才是 0 的极小值
 * 同样不带符号（比如 digits=1 时 -0.03 写成 `0.0%`，不是 `−0.0%`）——按显示出来的数判断正负号，
 * 不按原始值的符号位（T10.197 评审 P3-5，对应 T10.186 复查 N-2 的姊妹缺口）。
 */
export function formatSignedPercent(value: number | null | undefined, digits = 1): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return COST_UNAVAILABLE;
  const text = `${Math.abs(value).toFixed(digits)}%`;
  if (Number(Math.abs(value).toFixed(digits)) === 0) return text;
  return `${value > 0 ? '+' : '−'}${text}`;
}

/**
 * @deprecated 用 `formatEstimatedUsd(value)`。保留旧名给尚未迁移的调用方，行为与汇总格式一致：
 * 未知写「不可得」而不是旧版的 `≈$0.00`（GLB-01）。
 */
export function formatUsdApprox(value: number | null | undefined): string {
  return formatEstimatedUsd(value, 'summary');
}

// Token magnitudes: K keeps one decimal, M and B keep two (T10.161 added B, so
// cache-inclusive totals no longer render as `3456.78M`). The unit follows the
// absolute value and the sign is kept, so negative deltas abbreviate the same
// way positive ones do. A value that rounds up to 1000 of a unit moves to the
// next unit (999,999 → `1.00M`, not `1000.0K`); B is the largest unit, so
// ≥ 999.995B stays `1000.00B` (a personal ledger does not reach 1e12 tokens).
// Missing or non-finite input (null, undefined, NaN, ±Infinity) is unknown, not
// zero: it renders `—`, never `0` and never text built from `Infinity`/`NaN`
// (GLB-01). Magnitudes below 0.5 render `0` without a sign (no `-0`).
const TOKEN_UNITS = [
  { base: 1_000, suffix: 'K', digits: 1 },
  { base: 1_000_000, suffix: 'M', digits: 2 },
  { base: 1_000_000_000, suffix: 'B', digits: 2 },
] as const;

// Rounds `numerator / denominator` (both non-negative, denominator > 0) to the
// nearest integer, ties away from zero (i.e. up, since neither operand is
// negative) — via exact integer arithmetic, so the result never depends on the
// binary imprecision of dividing by 1e3/1e6/1e9 (T10.204; 1,150 / 1,000 = 1.15
// is not exactly representable in binary, so `(1.15).toFixed(1)` rounds down
// to `1.1` instead of the decimal-correct, half-away-from-zero `1.2`).
function divideRoundHalfAwayFromZero(numerator: number, denominator: number): number {
  const whole = Math.floor(numerator / denominator);
  const remainder = numerator - whole * denominator;
  return remainder * 2 >= denominator ? whole + 1 : whole;
}

// `magnitude / TOKEN_UNITS[unitIndex].base` formatted with that unit's decimal
// digits, rounded on the displayed decimal value rather than the binary float
// (T10.204). Real token counts are non-negative integers, which keeps this in
// exact integer arithmetic; a fractional `magnitude` (only reachable from the
// frontend, e.g. an average) falls back to `Intl.NumberFormat`, whose rounding
// `formatEstimatedUsd` above already relies on for the same reason.
function formatUnitMagnitude(magnitude: number, unitIndex: number): string {
  const { base, digits } = TOKEN_UNITS[unitIndex];
  if (Number.isInteger(magnitude)) {
    const scaled = divideRoundHalfAwayFromZero(magnitude * 10 ** digits, base);
    const text = String(scaled).padStart(digits + 1, '0');
    // Every TOKEN_UNITS entry has digits >= 1 (K keeps 1, M/B keep 2), so the
    // decimal point always lands inside `text` — no digits === 0 case exists.
    return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
  }
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  }).format(magnitude / base);
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const val = Number(value);
  if (!Number.isFinite(val)) return '—';
  const negative = val < 0;
  const magnitude = Math.abs(val);
  // Rounded on the non-negative magnitude, never the signed value: `Math.round`
  // on a negative input in [-0.5, 0) returns `-0` (formatTokens(-0.5) used to
  // print "-0"). The sign is re-applied afterwards, and only when non-zero.
  const roundedWhole = Math.round(magnitude);
  if (roundedWhole < 1_000) {
    return roundedWhole === 0 ? formatNum(0) : formatNum(negative ? -roundedWhole : roundedWhole);
  }
  let unit: number = magnitude >= 1_000_000_000 ? 2 : magnitude >= 1_000_000 ? 1 : 0;
  let text = formatUnitMagnitude(magnitude, unit);
  if (Number(text) >= 1_000 && unit < TOKEN_UNITS.length - 1) {
    unit += 1;
    text = formatUnitMagnitude(magnitude, unit);
  }
  return `${negative ? '-' : ''}${text}${TOKEN_UNITS[unit].suffix}`;
}

// Chart axis ticks (T10.179, T10.164 review N3): the same K/M/B ladder and
// carry as formatTokens, with trailing zeros trimmed because ticks are round
// numbers: `1.5M`, `2B` (never `2000M`), 999,950 → `1M` (never `1000K`).
// Magnitudes below 1000 print as given, so a fractional tick such as 0.5 keeps
// its value. A non-finite value is unknown and never becomes a number (GLB-01).
export function formatAxisTokens(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude < 1_000) return String(value);
  let unit: number = magnitude >= 1_000_000_000 ? 2 : magnitude >= 1_000_000 ? 1 : 0;
  let scaled = Number(formatUnitMagnitude(magnitude, unit));
  if (scaled >= 1_000 && unit < TOKEN_UNITS.length - 1) {
    unit += 1;
    scaled = Number(formatUnitMagnitude(magnitude, unit));
  }
  return `${value < 0 ? '-' : ''}${scaled}${TOKEN_UNITS[unit].suffix}`;
}

export function formatLocalDateTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
