import type { CustomDateRange, RangeKey } from '../types';
import { getLang, t, type Lang, type MessageKey } from '../i18n';

/**
 * RangeKey 的看板标签唯一事实源。
 * 口径与 Rust 后端 `StatsRange` 对齐：week 为周一起的自然周、month 为月初起的
 * 自然月、year 为本年度、all 为全部历史——均非滚动窗口，因此不得再标注
 * “最近 7 天 / 最近 30 天”这类会误导用户的文案。
 * custom 是用户指定的本地日期闭区间（T10.108）；有具体日期时用 formatCustomRangeLabel。
 * 报告导出目前只有中文，调用方传 `target: 'zh'` 固定语言。
 */
const RANGE_DISPLAY_KEYS: Record<RangeKey, MessageKey> = {
  today: 'rangeName.today',
  week: 'rangeName.week',
  month: 'rangeName.month',
  year: 'rangeName.year',
  all: 'rangeName.all',
  custom: 'rangeName.custom',
};

const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayLabel(value: string, withYear: boolean, target: Lang): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (target === 'en') {
    const monthName = EN_MONTHS[month - 1];
    if (!monthName) return null;
    return withYear ? `${monthName} ${day}, ${year}` : `${monthName} ${day}`;
  }
  return withYear ? `${year}年${month}月${day}日` : `${month}月${day}日`;
}

/** 单日 → “2026年8月2日”；同年 → “8月1日—8月31日”；跨年 → 两端都带年份。英文为 “Aug 1 – Aug 31”。 */
export function formatCustomRangeLabel(start: string, end: string, target: Lang = getLang()): string {
  const crossYear = start.slice(0, 4) !== end.slice(0, 4);
  const startLabel = dayLabel(start, crossYear, target);
  const endLabel = dayLabel(end, crossYear, target);
  if (!startLabel || !endLabel) return t(RANGE_DISPLAY_KEYS.custom, undefined, target);
  if (start === end) return dayLabel(start, true, target) ?? startLabel;
  return target === 'en' ? `${startLabel} – ${endLabel}` : `${startLabel}—${endLabel}`;
}

export function rangeDisplayName(range: RangeKey, customRange?: CustomDateRange | null, target: Lang = getLang()): string {
  if (range === 'custom' && customRange) return formatCustomRangeLabel(customRange.start, customRange.end, target);
  return t(RANGE_DISPLAY_KEYS[range], undefined, target);
}
