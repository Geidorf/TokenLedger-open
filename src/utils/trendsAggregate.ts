import type { TrendPoint } from '../types';

export type TrendBucketKind = 'hour' | 'day' | 'month';

/**
 * 契约事实源（docs/contracts/dashboard-stats-v2.md §1）：`trends[]` 的每个点是
 * `{ date, <工具名>: token 数, ... }`，**不存在** `totalTokens`/`tokens` 字段；
 * 分桶 `date` 的格式随 range 变化：today→`HH:00`、week/month→`YYYY-MM-DD`、
 * year→月份桶、all→`YYYY-MM-DD`。`__` 前缀是跨端保留键（例如云端
 * `__requests`），不属于工具序列；因此「某桶的总量」只能求和普通工具键。
 */
export function trendBucketTokens(point: TrendPoint | null | undefined): number {
  if (!point) return 0;
  let sum = 0;
  for (const [key, value] of Object.entries(point)) {
    if (key === 'date' || key.startsWith('__')) continue;
    if (typeof value === 'number' && Number.isFinite(value)) sum += value;
  }
  return sum;
}

/** 识别一个 `date` 桶的粒度；无法识别的格式返回 null（不得按 0 或猜测处理）。 */
export function trendBucketKind(date: string | null | undefined): TrendBucketKind | null {
  if (typeof date !== 'string' || date === '') return null;
  if (/^(?:[01]\d|2[0-3]):00$/.test(date)) return 'hour';
  if (/^(?:0?[1-9]|1[0-2])(?:月|M)$/.test(date)) return 'month';
  if (/^\d{4}-(?:0[1-9]|1[0-2])$/.test(date)) return 'month';
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [year, month, day] = date.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day
    ) return 'day';
  }
  return null;
}

/**
 * 把 `YYYY-MM-DD` 日桶解析为星期（0=周日）。日期字符串已经是查询时区内的
 * civil date；使用 UTC 构造只为得到确定性的格里高利历星期，结果不得随宿主机
 * 时区或 DST 改变。
 */
export function weekdayOfDateBucket(date: string | null | undefined): number | null {
  if (trendBucketKind(date) !== 'day' || typeof date !== 'string') return null;
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** 桶日期是否可作为明细下钻日期（只有完整 `YYYY-MM-DD` 桶能直接喂给 onSelectDate）。 */
export function isDrillableDateBucket(date: string | null | undefined): date is string {
  return trendBucketKind(date) === 'day';
}
