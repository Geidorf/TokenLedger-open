import { Calendar, Share2 } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useSegmentedIndicator } from '../hooks/useSegmentedIndicator';
import type { CustomDateRange, RangeKey } from '../types';
import { customRangeSpanDays, isoCalendarDayValue, MAX_CUSTOM_RANGE_DAYS } from '../utils/frontendContracts';
import { formatCustomRangeLabel } from '../utils/rangeDisplay';
import { FOCUSABLE_SELECTOR, focusAfterPopoverTrigger, useAnchoredPopover } from './anchoredPopover';

const RANGE_OPTIONS: Array<[RangeKey, string]> = [
  ['today', '今日'],
  ['week', '本周'],
  ['month', '本月'],
  ['year', '今年'],
  ['all', '总计'],
];

const defaultNow = () => new Date();

function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function shiftDays(date: Date, days: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

export interface CustomRangePreset {
  id: string;
  label: string;
  resolve: (today: Date) => CustomDateRange;
}

/** 常用复盘区间，全部相对“今天”按本地日历解析；周一为一周首日，与 Rust `week` 口径一致。 */
export const CUSTOM_RANGE_PRESETS: ReadonlyArray<CustomRangePreset> = [
  {
    id: 'yesterday',
    label: '昨天',
    resolve: (today) => {
      const day = isoDay(shiftDays(today, -1));
      return { start: day, end: day };
    },
  },
  { id: 'last-7-days', label: '最近 7 天', resolve: (today) => ({ start: isoDay(shiftDays(today, -6)), end: isoDay(today) }) },
  { id: 'last-30-days', label: '最近 30 天', resolve: (today) => ({ start: isoDay(shiftDays(today, -29)), end: isoDay(today) }) },
  {
    id: 'last-week',
    label: '上周',
    resolve: (today) => {
      const monday = shiftDays(today, -((today.getDay() + 6) % 7));
      const start = shiftDays(monday, -7);
      return { start: isoDay(start), end: isoDay(shiftDays(start, 6)) };
    },
  },
  {
    id: 'last-month',
    label: '上月',
    resolve: (today) => ({
      start: isoDay(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
      end: isoDay(new Date(today.getFullYear(), today.getMonth(), 0)),
    }),
  },
  {
    id: 'this-quarter',
    label: '本季度',
    resolve: (today) => ({
      start: isoDay(new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1)),
      end: isoDay(today),
    }),
  },
  {
    id: 'last-quarter',
    label: '上季度',
    resolve: (today) => {
      const quarterStart = Math.floor(today.getMonth() / 3) * 3;
      return {
        start: isoDay(new Date(today.getFullYear(), quarterStart - 3, 1)),
        end: isoDay(new Date(today.getFullYear(), quarterStart, 0)),
      };
    },
  },
];

/** 返回给用户看的校验错误；通过时返回 null。规则与 `normalizeStatsQuery` / Rust 一致。 */
export function validateCustomRangeInput(start: string, end: string, todayIso: string): string | null {
  if (!start || !end) return '请选择开始和结束日期';
  if (isoCalendarDayValue(start) === null || isoCalendarDayValue(end) === null) return '日期格式无效，请使用 YYYY-MM-DD';
  if (start > todayIso) return '开始日期不能晚于今天';
  const span = customRangeSpanDays(start, end);
  if (span === null) return '开始日期不能晚于结束日期';
  if (span > MAX_CUSTOM_RANGE_DAYS) return `最多支持 ${MAX_CUSTOM_RANGE_DAYS} 天（约两年）`;
  return null;
}

interface RangeControlProps {
  range: RangeKey;
  /** range === 'custom' 时的日期闭区间；触发按钮据此显示已选范围。 */
  customRange?: CustomDateRange | null;
  onRangeChange: (range: RangeKey, bounds?: CustomDateRange | null) => void;
  /** 注入“今天”：预设区间与日期上限据此计算，测试可固定时间。 */
  now?: () => Date;
}

/** 全局统计时间范围：五个预设 + 「自定义」日期弹层。顶栏（活动明细）与用量工具行共用。 */
export function RangeControl({ range, customRange = null, onRangeChange, now = defaultNow }: RangeControlProps) {
  const [customMenuOpen, setCustomMenuOpen] = useState(false);
  const [draftStart, setDraftStart] = useState('');
  const [draftEnd, setDraftEnd] = useState('');
  const [customError, setCustomError] = useState('');
  const customMenuRef = useRef<HTMLDivElement>(null);
  const customPopoverRef = useRef<HTMLDivElement>(null);
  const customButtonRef = useRef<HTMLButtonElement>(null);
  const customStartRef = useRef<HTMLInputElement>(null);
  const todayIso = isoDay(now());
  const customRangeLabel = customRange ? formatCustomRangeLabel(customRange.start, customRange.end) : '自定义';
  // One sliding selection pill per segmented group (T10.150); aria-pressed stays the source of truth.
  const rangeIndicatorRef = useSegmentedIndicator<HTMLDivElement>();
  const customPopoverStyle = useAnchoredPopover(customMenuOpen, customButtonRef, customPopoverRef, 10, 344);

  // 点外部或键盘移出关闭；Escape 关闭并把焦点还给触发按钮。
  useEffect(() => {
    if (!customMenuOpen) return undefined;
    const closeFromOutside = (event: Event) => {
      if (
        event.target instanceof Node
        && !customMenuRef.current?.contains(event.target)
        && !customPopoverRef.current?.contains(event.target)
      ) {
        setCustomMenuOpen(false);
      }
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setCustomMenuOpen(false);
      customButtonRef.current?.focus();
    };
    document.addEventListener('mousedown', closeFromOutside);
    document.addEventListener('focusin', closeFromOutside);
    document.addEventListener('keydown', closeFromEscape);
    const frame = window.requestAnimationFrame(() => customStartRef.current?.focus());
    return () => {
      document.removeEventListener('mousedown', closeFromOutside);
      document.removeEventListener('focusin', closeFromOutside);
      document.removeEventListener('keydown', closeFromEscape);
      window.cancelAnimationFrame(frame);
    };
  }, [customMenuOpen]);

  const toggleCustomMenu = () => {
    if (customMenuOpen) {
      setCustomMenuOpen(false);
      return;
    }
    const today = now();
    setDraftStart(customRange?.start ?? isoDay(shiftDays(today, -6)));
    setDraftEnd(customRange?.end ?? isoDay(today));
    setCustomError('');
    setCustomMenuOpen(true);
  };

  const applyCustomRange = (bounds: CustomDateRange) => {
    onRangeChange('custom', bounds);
    setCustomMenuOpen(false);
    customButtonRef.current?.focus();
  };

  const submitCustomDraft = () => {
    const error = validateCustomRangeInput(draftStart, draftEnd, todayIso);
    if (error) {
      setCustomError(error);
      return;
    }
    applyCustomRange({ start: draftStart, end: draftEnd });
  };

  const handleCustomMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      const popover = customPopoverRef.current;
      if (!popover) return;
      const focusable = [...popover.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) => element.tabIndex >= 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && event.target === first) {
        event.preventDefault();
        setCustomMenuOpen(false);
        customButtonRef.current?.focus();
      } else if (!event.shiftKey && event.target === last) {
        event.preventDefault();
        setCustomMenuOpen(false);
        if (customButtonRef.current) focusAfterPopoverTrigger(customButtonRef.current);
      }
      return;
    }
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      submitCustomDraft();
    }
  };

  return (
    <div ref={rangeIndicatorRef} className="segmented range-control tl-seg" role="group" aria-label="统计时间范围">
      {RANGE_OPTIONS.map(([key, label]) => (
        <button
          key={key}
          className={range === key ? 'active' : ''}
          aria-pressed={range === key}
          onClick={() => onRangeChange(key)}
        >
          {label}
        </button>
      ))}
      <div className="custom-range-menu" ref={customMenuRef}>
        <button
          ref={customButtonRef}
          type="button"
          className={range === 'custom' ? 'active' : ''}
          aria-pressed={range === 'custom'}
          aria-haspopup="dialog"
          aria-expanded={customMenuOpen}
          aria-label={range === 'custom' && customRange ? `自定义范围：${customRangeLabel}` : '自定义日期范围'}
          title="按指定日期或时间段复盘"
          onClick={toggleCustomMenu}
        >
          <Calendar className="h-3.5 w-3.5" />
          <span>{range === 'custom' && customRange ? customRangeLabel : '自定义'}</span>
        </button>
        {customMenuOpen && createPortal(
          <div
            className="custom-range-popover"
            data-header-popover
            ref={customPopoverRef}
            role="dialog"
            aria-label="自定义日期范围"
            style={customPopoverStyle}
            onKeyDown={handleCustomMenuKeyDown}
          >
            <div className="theme-menu-heading">自定义日期范围</div>
            <div className="custom-range-presets" role="group" aria-label="常用区间">
              {CUSTOM_RANGE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="custom-range-preset"
                  onClick={() => applyCustomRange(preset.resolve(now()))}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="custom-range-fields">
              <label className="custom-range-field">
                <span>开始日期</span>
                <input
                  ref={customStartRef}
                  type="date"
                  value={draftStart}
                  max={todayIso}
                  onChange={(event) => { setDraftStart(event.target.value); setCustomError(''); }}
                />
              </label>
              <label className="custom-range-field">
                <span>结束日期</span>
                <input
                  type="date"
                  value={draftEnd}
                  min={draftStart || undefined}
                  max={todayIso}
                  onChange={(event) => { setDraftEnd(event.target.value); setCustomError(''); }}
                />
              </label>
            </div>
            {customError && <p className="custom-range-error" role="alert">{customError}</p>}
            <div className="custom-range-actions">
              <span className="custom-range-hint">含首尾两天，最长 {MAX_CUSTOM_RANGE_DAYS} 天；自动与紧邻的上一段等长区间对比。</span>
              <button type="button" className="custom-range-apply" onClick={submitCustomDraft}>应用</button>
            </div>
          </div>,
          document.body,
        )}
      </div>
    </div>
  );
}

interface TokenModeToggleProps {
  showTotalTokens: boolean;
  onToggleTokenMode: () => void;
  cachedTokens?: number;
}

/** 概览指标的「有效 / 含缓存」口径；趋势与专属分析始终用有效 Token。 */
export function TokenModeToggle({ showTotalTokens, onToggleTokenMode, cachedTokens }: TokenModeToggleProps) {
  const tokenModeIndicatorRef = useSegmentedIndicator<HTMLDivElement>();
  return (
    <div ref={tokenModeIndicatorRef} className="segmented tl-seg" role="group" aria-label="概览 Token 口径">
      <button
        className={!showTotalTokens ? 'active' : ''}
        aria-pressed={!showTotalTokens}
        onClick={() => showTotalTokens && onToggleTokenMode()}
        title={cachedTokens === 0
          ? '当前周期未记录到缓存 Token；概览指标使用输入 + 输出 Token'
          : '概览指标使用输入 + 输出 Token；趋势与专属分析始终使用此有效口径'}
      >
        概览有效
      </button>
      <button
        className={showTotalTokens ? 'active' : ''}
        aria-pressed={showTotalTokens}
        onClick={() => !showTotalTokens && onToggleTokenMode()}
        title={cachedTokens === 0
          ? '当前周期未记录到缓存 Token，概览有效与含缓存数值相同'
          : '仅概览指标加入缓存量；趋势与专属分析仍保持有效 Token 口径'}
      >
        概览含缓存
      </button>
    </div>
  );
}

interface CloudDeviceSelectProps {
  deviceFilter: string;
  deviceList: string[];
  onDeviceFilterChange: (filter: string) => void;
}

/** 云端汇总下的设备筛选；本机视图没有这一项。 */
export function CloudDeviceSelect({ deviceFilter, deviceList, onDeviceFilterChange }: CloudDeviceSelectProps) {
  return (
    <select
      className="control-select"
      aria-label="云端设备筛选"
      value={deviceFilter}
      onChange={(event) => onDeviceFilterChange(event.target.value)}
    >
      <option value="all_cloud">全部设备</option>
      {deviceList.map((machine) => (
        <option key={machine} value={machine}>
          {machine}
        </option>
      ))}
    </select>
  );
}

export function ShareCardButton({ onOpenShareCard }: { onOpenShareCard: () => void }) {
  return (
    <button
      className="icon-command share-card-toggle"
      title="生成并分享数据战报图片"
      aria-label="生成并分享数据战报图片"
      onClick={onOpenShareCard}
    >
      <Share2 className="h-4 w-4" />
      <span>战报</span>
    </button>
  );
}
