'use strict';

// 状态栏与悬停卡片里的数字写法。只管「怎么写」，不算任何数：数字全部来自
// tokenledger-cli 的 JSON。Token 与费用的写法与看板、托盘逐字相同（DESIGN §4.1、
// §4.4），用仓库里的共用黄金用例 fixtures/token-format-v1 与
// fixtures/estimated-usd-format-v1 校验（test/format.test.js）。

const COST_UNAVAILABLE = '不可得';

const USD = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const ZH_NUMBER = new Intl.NumberFormat('zh-CN');

function isKnownCost(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** 汇总级预估费用：`≈$1,422.78`，0 < v < 0.01 写 `<$0.01`，读不到写「不可得」，不写 $0。 */
function formatEstimatedUsd(value) {
  if (!isKnownCost(value)) return COST_UNAVAILABLE;
  if (value === 0) return '≈$0.00';
  return value < 0.01 ? '<$0.01' : `≈$${USD.format(value)}`;
}

/** 预算上限这类用户自己填的金额：不带 ≈。 */
function formatUsdAmount(value) {
  if (!isKnownCost(value)) return COST_UNAVAILABLE;
  return `$${USD.format(value)}`;
}

const TOKEN_UNITS = [
  { base: 1_000, suffix: 'K', digits: 1 },
  { base: 1_000_000, suffix: 'M', digits: 2 },
  { base: 1_000_000_000, suffix: 'B', digits: 2 },
];

// 整数运算求商并四舍五入（半数远离 0），不受 1e3/1e6/1e9 二进制除法误差影响。
function divideRoundHalfAwayFromZero(numerator, denominator) {
  const whole = Math.floor(numerator / denominator);
  const remainder = numerator - whole * denominator;
  return remainder * 2 >= denominator ? whole + 1 : whole;
}

function formatUnitMagnitude(magnitude, unitIndex) {
  const { base, digits } = TOKEN_UNITS[unitIndex];
  if (Number.isInteger(magnitude)) {
    const scaled = divideRoundHalfAwayFromZero(magnitude * 10 ** digits, base);
    const text = String(scaled).padStart(digits + 1, '0');
    return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
  }
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  }).format(magnitude / base);
}

/** Token 量级缩写：`999`、`1.2K`、`1.00M`、`3.46B`；读不到写「—」。 */
function formatTokens(value) {
  if (value === null || value === undefined) return '—';
  const val = Number(value);
  if (!Number.isFinite(val)) return '—';
  const negative = val < 0;
  const magnitude = Math.abs(val);
  const roundedWhole = Math.round(magnitude);
  if (roundedWhole < 1_000) {
    return ZH_NUMBER.format(roundedWhole === 0 ? 0 : negative ? -roundedWhole : roundedWhole);
  }
  let unit = magnitude >= 1_000_000_000 ? 2 : magnitude >= 1_000_000 ? 1 : 0;
  let text = formatUnitMagnitude(magnitude, unit);
  if (Number(text) >= 1_000 && unit < TOKEN_UNITS.length - 1) {
    unit += 1;
    text = formatUnitMagnitude(magnitude, unit);
  }
  return `${negative ? '-' : ''}${text}${TOKEN_UNITS[unit].suffix}`;
}

/** 百分比：接近整数写整数，否则 1 位小数；与命令行的写法相同。 */
function formatPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return Math.abs(value - Math.round(value)) < 0.05 ? `${Math.round(value)}%` : `${value.toFixed(1)}%`;
}

function formatCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return ZH_NUMBER.format(Math.round(value));
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 本地 `HH:MM`。 */
function formatClock(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * 重置时间：一小时内写「N 分钟后重置」，一天内写「X 小时 Y 分后重置」，再远写本地
 * 「MM-DD HH:MM 重置」；已过写「已到重置时间」；读不到返回空串。
 */
function formatResetsAt(resetsAt, now) {
  if (typeof resetsAt !== 'string' || !resetsAt) return '';
  const target = new Date(resetsAt);
  if (Number.isNaN(target.getTime())) return '';
  const minutes = Math.ceil((target.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return '已到重置时间';
  if (minutes < 60) return `${minutes} 分钟后重置`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours} 小时后重置` : `${hours} 小时 ${rest} 分后重置`;
  }
  return `${pad2(target.getMonth() + 1)}-${pad2(target.getDate())} ${formatClock(target)} 重置`;
}

module.exports = {
  COST_UNAVAILABLE,
  formatClock,
  formatCount,
  formatEstimatedUsd,
  formatPercent,
  formatResetsAt,
  formatTokens,
  formatUsdAmount,
  isKnownCost,
};
