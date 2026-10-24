import type { ReactNode } from 'react';
import type { CustomDateRange, RangeKey } from '../types';
import { formatTokens } from '../utils/format';
import { rhythmLevel, type InsightTimeContext } from '../utils/insightRules';

/**
 * 查询实际覆盖的本地日期闭区间（YYYY-MM-DD）。区间外且没有记录的日期没有被查询，不能画成 0（GLB-01）。
 * - `start = null`：不设起点（“全部”）。
 * - `end = null`：无法确认这份快照查询到哪一天，只有响应里有记录的日期算已知。
 */
export interface HeatmapCoverage {
  start: string | null;
  end: string | null;
}

/**
 * 快照自己的查询截止点（`deriveInsightTimeContext` 的结果）：`cutoffDate` 是快照实际查询到的
 * 最后一个本地日期，`timeZone` 是日期键所在时区。刷新失败时界面沿用旧快照，覆盖只能算到它为止。
 */
export type HeatmapSnapshotCutoff = Pick<InsightTimeContext, 'cutoffDate' | 'timeZone'>;

export interface HeatmapWindow {
  /** 要画的公历年。 */
  year: number;
  /** 今天（YYYY-MM-DD，快照时区；时区未知时用本机日期），晚于它的日期“尚未到来”。 */
  today: string;
  coverage: HeatmapCoverage | null;
}

export interface YearHeatmapProps {
  heatmap: Record<string, number>;
  onSelectDate?: (date: string) => void;
  /** 要画的公历年；缺省为今天所在年。 */
  year?: number;
  /** 查询覆盖；缺省视为当年已到来的日期都已查询（专属看板等年度底图的既有语义）。 */
  coverage?: HeatmapCoverage | null;
  /** 今天（YYYY-MM-DD）；缺省用本机日期。 */
  today?: string;
  /** 单格数值的写法；缺省按 Token 写。 */
  formatValue?: (value: number) => string;
}

const formatTokenValue = (value: number) => `${formatTokens(value)} Tokens`;

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 某时区里今天的日期键；时区缺失或无效时退回本机日期。 */
function civilToday(now: Date, timeZone: string | null | undefined): string {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
      const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
      const key = `${part('year')}-${part('month')}-${part('day')}`;
      if (DAY_KEY.test(key)) return key;
    } catch {
      // 无效时区：退回本机日期。
    }
  }
  return isoDay(now);
}

const earliest = (...keys: string[]) => keys.reduce((a, b) => (b < a ? b : a));
const latest = (...keys: string[]) => keys.reduce((a, b) => (b > a ? b : a));

/** 与 Rust `week` 口径一致：周一为一周首日。 */
function mondayOf(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

/**
 * 由全局范围与快照自己的截止点推出日历要画的年份、今天与查询覆盖（T10.161）。不发起新查询，
 * 只如实描述这份响应覆盖了哪些日期：
 * - 覆盖终点取快照的截止日，不取本机时钟——刷新失败沿用旧快照时，之后的日期是“未查询”，不是 0；
 *   截止点未知时终点为 null，没有记录的日期一律算未查询。
 * - 自定义范围画区间里最后一个已查询（至少已到来）的日期所在年：往年区间不画空白的今年，
 *   终点晚于今天也不画一整年“尚未到来”。预设范围画今天所在年。
 */
export function resolveHeatmapWindow(
  range: RangeKey | undefined,
  customRange: CustomDateRange | null | undefined,
  snapshot: HeatmapSnapshotCutoff | null | undefined,
  now: Date = new Date(),
): HeatmapWindow {
  const today = civilToday(now, snapshot?.timeZone);
  const todayYear = Number(today.slice(0, 4));
  const cutoff = snapshot && DAY_KEY.test(snapshot.cutoffDate) ? earliest(snapshot.cutoffDate, today) : null;
  // 预设范围的查询窗口按快照截止日所在的年、月、周推算；截止点未知时退回今天，终点仍记为未知。
  const anchor = cutoff ?? today;
  switch (range) {
    case 'custom': {
      const start = customRange?.start;
      const end = customRange?.end;
      if (!start || !end || !DAY_KEY.test(start) || !DAY_KEY.test(end) || start > end) {
        return { year: todayYear, today, coverage: { start: null, end: null } };
      }
      const last = latest(start, earliest(end, today, ...(cutoff ? [cutoff] : [])));
      const coveredEnd = cutoff ? earliest(end, cutoff) : null;
      return {
        year: Number(last.slice(0, 4)),
        today,
        coverage: { start, end: coveredEnd !== null && coveredEnd >= start ? coveredEnd : null },
      };
    }
    case 'all':
      return { year: todayYear, today, coverage: { start: null, end: cutoff } };
    case 'year':
      return { year: todayYear, today, coverage: { start: `${anchor.slice(0, 4)}-01-01`, end: cutoff } };
    case 'month':
      return { year: todayYear, today, coverage: { start: `${anchor.slice(0, 7)}-01`, end: cutoff } };
    case 'week':
      return { year: todayYear, today, coverage: { start: mondayOf(anchor), end: cutoff } };
    case 'today':
      return { year: todayYear, today, coverage: { start: anchor, end: cutoff } };
    default:
      return { year: todayYear, today, coverage: null };
  }
}

/**
 * 查询覆盖只占所画年份一部分时的说明；整年（到今天为止）都查询过时返回空串。
 * 日历正文与读屏摘要共用这一句，避免两处说法不一。`today` 为 YYYY-MM-DD。
 */
export function heatmapCoverageNote(year: number, coverage: HeatmapCoverage | null | undefined, today: string): string {
  if (!coverage) return '';
  if (coverage.end === null) {
    return '无法确认这份数据查询到哪一天，没有记录的日期都按未查询显示，不代表没有用量。';
  }
  const yearStart = `${year}-01-01`;
  const yearEnd = earliest(`${year}-12-31`, today);
  const notes: string[] = [];
  if (yearEnd >= yearStart && ((coverage.start !== null && coverage.start > yearStart) || coverage.end < yearEnd)) {
    notes.push(`只查询了 ${coverage.start ?? '最早记录'} 至 ${coverage.end}，其余日期未查询，不代表没有用量`);
  }
  if (coverage.start !== null && coverage.start < yearStart) {
    notes.push(`${coverage.start.slice(0, 4)} 年的部分不在本日历中`);
  }
  return notes.length > 0 ? `${notes.join('；')}。` : '';
}

export function YearHeatmap({ heatmap, onSelectDate, year: yearProp, coverage, today, formatValue }: YearHeatmapProps) {
  const todayKey = today && DAY_KEY.test(today) ? today : isoDay(new Date());
  const year = yearProp ?? Number(todayKey.slice(0, 4));
  const inCoverage = (date: string) => !coverage
    || (coverage.end !== null && (coverage.start === null || date >= coverage.start) && date <= coverage.end);
  // 有记录的日期就是已知数据；覆盖只决定“没有记录”的日期是已知的 0 还是未查询。
  const observedDays = Object.entries(heatmap)
    .filter(([date, tokens]) => date.startsWith(`${year}-`) && date <= todayKey && tokens > 0);
  const totalTokens = observedDays.reduce((sum, [, tokens]) => sum + tokens, 0);
  const peak = observedDays.reduce<[string, number] | null>(
    (current, entry) => (!current || entry[1] > current[1] ? entry : current),
    null,
  );
  // 与分时段节奏格同一把尺（T10.111 `rhythmLevel`）：按本年已知日期的峰值相对分 5 档，单色相由浅到深。
  const maxTokens = peak ? peak[1] : 0;
  const coverageNote = heatmapCoverageNote(year, coverage, todayKey);
  const summary = formatValue
    ? `${year} 年活跃日历：${observedDays.length} 个有消耗的日期，总计 ${formatValue(totalTokens)}${peak ? `，峰值 ${peak[0]} 为 ${formatValue(peak[1])}` : ''}。${coverageNote}`
    : `${year} 年活跃日历：${observedDays.length} 个有消耗的日期，总计 ${formatTokens(totalTokens)} Token${peak ? `，峰值 ${peak[0]} 为 ${formatTokens(peak[1])}` : ''}。${coverageNote}`;
  const cellValue = formatValue ?? formatTokenValue;
  const hasInteractiveDays = observedDays.length > 0 && typeof onSelectDate === 'function';

  return (
    <div
      className="year-heatmap"
      role="group"
      aria-label={summary}
      tabIndex={hasInteractiveDays ? -1 : 0}
    >
      {Array.from({ length: 12 }, (_, monthIdx) => {
        const month = monthIdx + 1;
        const daysInMonth = new Date(year, month, 0).getDate();
        const firstDay = new Date(year, month - 1, 1).getDay();
        const cells: ReactNode[] = [];

        for (let i = 0; i < firstDay; i += 1) {
          cells.push(<div key={`pad-${i}`} className="heatmap-cell heat-empty" />);
        }

        for (let day = 1; day <= daysInMonth; day += 1) {
          const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const isFuture = date > todayKey;
          const known = !isFuture && (inCoverage(date) || Object.prototype.hasOwnProperty.call(heatmap, date));
          const tokens = known ? heatmap[date] || 0 : 0;
          const level = known ? rhythmLevel(tokens, maxTokens) : 0;
          const isClickable = known && tokens > 0 && typeof onSelectDate === 'function';

          // 未来与未查询的日期没有数据，读屏与悬停提示都不能说成 0 Token。
          const valueLabel = isFuture ? '尚未到来' : known ? cellValue(tokens) : '未查询';
          const title = `${date}: ${valueLabel}${isClickable ? ' (点击查看当日明细)' : ''}`;
          const ariaLabel = isClickable ? `${date}: ${valueLabel}，点击查看当日明细` : `${date}: ${valueLabel}`;
          const stateClass = isFuture ? ' heat-future' : !known ? ' heat-unknown' : level === 0 ? ' heat-0' : '';
          const cellClass = `heatmap-cell${stateClass}${isClickable ? ' cursor-pointer hover:ring-1 hover:ring-primary' : ''}`;
          const dataLevel = level > 0 ? level : undefined;

          if (isClickable) {
            cells.push(
              <button
                key={date}
                type="button"
                role="button"
                tabIndex={0}
                className={cellClass}
                data-level={dataLevel}
                title={title}
                aria-label={ariaLabel}
                onClick={() => onSelectDate(date)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectDate(date);
                  }
                }}
              />,
            );
          } else {
            cells.push(
              <div
                key={date}
                className={cellClass}
                data-level={dataLevel}
                title={title}
                aria-label={ariaLabel}
              />,
            );
          }
        }

        return (
          <div key={month} className="heatmap-month">
            <div className="heatmap-month-title">{month}月</div>
            <div className="heatmap-weekdays">
              {WEEKDAYS.map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>
            <div className="heatmap-days">{cells}</div>
          </div>
        );
      })}
    </div>
  );
}

export default YearHeatmap;
