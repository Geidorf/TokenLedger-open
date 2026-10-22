import type { CustomDateRange, RangeKey } from '../types';

/**
 * RangeKey 的看板中文标签唯一事实源。
 * 口径与 Rust 后端 `StatsRange` 对齐：week 为周一起的自然周、month 为月初起的
 * 自然月、year 为本年度、all 为全部历史——均非滚动窗口，因此不得再标注
 * “最近 7 天 / 最近 30 天”这类会误导用户的文案。
 * custom 是用户指定的本地日期闭区间（T10.108）；有具体日期时用 formatCustomRangeLabel。
 */
export const RANGE_DISPLAY_NAMES: Record<RangeKey, string> = {
  today: '今日',
  week: '本周',
  month: '本月',
  year: '本年度',
  all: '全部历史',
  custom: '自定义区间',
};

function zhDay(value: string, withYear: boolean): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return withYear ? `${year}年${month}月${day}日` : `${month}月${day}日`;
}

/** 单日 → “2026年8月2日”；同年 → “8月1日—8月31日”；跨年 → 两端都带年份。 */
export function formatCustomRangeLabel(start: string, end: string): string {
  const crossYear = start.slice(0, 4) !== end.slice(0, 4);
  const startLabel = zhDay(start, crossYear);
  const endLabel = zhDay(end, crossYear);
  if (!startLabel || !endLabel) return RANGE_DISPLAY_NAMES.custom;
  if (start === end) return zhDay(start, true) ?? startLabel;
  return `${startLabel}—${endLabel}`;
}

export function rangeDisplayName(range: RangeKey, customRange?: CustomDateRange | null): string {
  if (range === 'custom' && customRange) return formatCustomRangeLabel(customRange.start, customRange.end);
  return RANGE_DISPLAY_NAMES[range];
}
