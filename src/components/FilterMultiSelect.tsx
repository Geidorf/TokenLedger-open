import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import type { FacetOption } from '../types';
import { formatNum } from '../utils/format';

interface FilterMultiSelectProps {
  label: string;
  values: string[];
  options: FacetOption[];
  disabled?: boolean;
  onChange: (values: string[]) => void;
}

interface FilterPopoverPlacementInput {
  rootLeft: number;
  rootWidth: number;
  visibleLeft: number;
  visibleRight: number;
}

export function getFilterPopoverPlacement({
  rootLeft,
  rootWidth,
  visibleLeft,
  visibleRight,
}: FilterPopoverPlacementInput) {
  const preferredWidth = Math.min(360, Math.max(280, rootWidth));
  const availableWidth = Math.max(1, visibleRight - visibleLeft);
  const width = Math.min(preferredWidth, availableWidth);
  const maxLeft = Math.max(visibleLeft, visibleRight - width);
  const left = Math.min(Math.max(rootLeft, visibleLeft), maxLeft);

  return {
    width: Math.floor(width),
    left: Math.floor(left - rootLeft),
    alignEnd: left < rootLeft,
  };
}

/** 弹层（含全部候选时）的高度上限。 */
const FILTER_POPOVER_MAX_HEIGHT = 480;

interface FilterPopoverVerticalInput {
  /** 触发块上缘到可视滚动区上缘（已扣 8px 边距与 7px 间隙）的空间。 */
  spaceAbove: number;
  /** 触发块下缘到可视滚动区下缘的空间。 */
  spaceBelow: number;
  /** 所有候选都展开时弹层的自然高度。 */
  naturalHeight: number;
  /** 搜索框 + 前 3 个候选（不足 3 个则全部）+ 页脚所需的高度。 */
  minimumHeight: number;
  /** 滚动区还能向下滚多少，且触发块仍留在可视区内（向下滚让触发块上移、下方变宽）。 */
  scrollRoomDown?: number;
  /** 滚动区还能向上滚多少，且触发块仍留在可视区内。 */
  scrollRoomUp?: number;
}

/**
 * 纵向落位：弹层绝不高于它所在一侧的可视空间——滚动区会把超出部分裁掉，
 * 翻到上方时就会塞进顶栏下面（T10.150 QA F13：1280×480 顶部被裁 21px）。
 * 两侧都放不下「搜索 + 3 个候选 + 页脚」时，先把滚动区滚出所需空间
 * （640×520 下原先只露 1 个候选），再按空间较大的一侧放。
 */
export function getFilterPopoverVerticalPlacement({
  spaceAbove,
  spaceBelow,
  naturalHeight,
  minimumHeight,
  scrollRoomDown = 0,
  scrollRoomUp = 0,
}: FilterPopoverVerticalInput) {
  const wanted = Math.min(FILTER_POPOVER_MAX_HEIGHT, naturalHeight);
  const needed = Math.min(wanted, minimumHeight);
  let below = spaceBelow;
  let above = spaceAbove;
  let scrollBy = 0;
  if (Math.max(below, above) < needed) {
    const down = Math.max(0, Math.min(scrollRoomDown, needed - below));
    const up = Math.max(0, Math.min(scrollRoomUp, needed - above));
    if (below + down >= above + up) {
      scrollBy = down;
      below += down;
      above -= down;
    } else {
      scrollBy = -up;
      above += up;
      below -= up;
    }
  }
  const alignTop = below < wanted && above > below;
  const room = Math.max(0, Math.floor(alignTop ? above : below));
  return {
    alignTop,
    maxHeight: Math.min(FILTER_POPOVER_MAX_HEIGHT, room),
    scrollBy: Math.round(scrollBy) || 0,
  };
}

function measureFilterPopoverHeights(popover: HTMLElement | null) {
  if (!popover) return { natural: 320, minimum: 320 };
  const list = popover.querySelector<HTMLElement>('.detail-option-list');
  if (!list) return { natural: popover.offsetHeight, minimum: popover.offsetHeight };
  // 列表之外的部分（内边距、搜索框、页脚与网格间隙）+ 列表的完整内容高度。
  const chrome = popover.offsetHeight - list.offsetHeight;
  const natural = chrome + list.scrollHeight;
  const rows = Array.from(list.querySelectorAll<HTMLElement>('.detail-option-row')).slice(0, 3);
  if (rows.length === 0) return { natural, minimum: natural };
  const rowGap = Number.parseFloat(getComputedStyle(list).rowGap) || 0;
  const minimum = chrome
    + rows.reduce((sum, row) => sum + row.offsetHeight, 0)
    + rowGap * (rows.length - 1);
  return { natural, minimum };
}

/** 一次最多能选多少个值。它是上限，不是候选数——页脚文案不要把它写成分母。 */
const SELECTION_LIMIT = 32;

export function FilterMultiSelect({
  label,
  values,
  options,
  disabled = false,
  onChange,
}: FilterMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [alignEnd, setAlignEnd] = useState(false);
  const [alignTop, setAlignTop] = useState(false);
  const [popoverMaxHeight, setPopoverMaxHeight] = useState<number | null>(null);
  const [popoverWidth, setPopoverWidth] = useState<number | null>(null);
  const [popoverLeft, setPopoverLeft] = useState<number | null>(null);
  const [optionSearch, setOptionSearch] = useState('');
  const [draftValues, setDraftValues] = useState(values);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionSearchInputRef = useRef<HTMLInputElement>(null);
  const optionListRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef(false);
  const listId = useId();
  const selectionSummaryId = `${listId}-selection-summary`;
  const mergedOptions = useMemo(() => {
    const byValue = new Map(options.map((option) => [option.value, option]));
    draftValues.forEach((value) => {
      if (!byValue.has(value)) byValue.set(value, { value, count: 0 });
    });
    const needle = optionSearch.trim().toLowerCase();
    return [...byValue.values()].filter((option) => (
      !needle || option.value.toLowerCase().includes(needle)
    ));
  }, [draftValues, optionSearch, options]);

  useEffect(() => {
    if (!open) return undefined;
    const closeFromOutside = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      restoreFocusRef.current = true;
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', closeFromOutside);
    document.addEventListener('keydown', closeFromEscape);
    return () => {
      document.removeEventListener('mousedown', closeFromOutside);
      document.removeEventListener('keydown', closeFromEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !rootRef.current) {
      if (!open) {
        setAlignTop(false);
        setPopoverMaxHeight(null);
        setPopoverWidth(null);
        setPopoverLeft(null);
      }
      return;
    }
    const updatePopoverPlacement = () => {
      const bounds = rootRef.current?.getBoundingClientRect();
      if (!bounds || !rootRef.current) return;
      const scrollPort = rootRef.current.closest<HTMLElement>('.app-content');
      const scrollPortBounds = scrollPort?.getBoundingClientRect();
      const visibleLeft = Math.max(scrollPortBounds?.left ?? 0, 0) + 8;
      const visibleRight = Math.min(scrollPortBounds?.right ?? window.innerWidth, window.innerWidth) - 8;
      const placement = getFilterPopoverPlacement({
        rootLeft: bounds.left,
        rootWidth: bounds.width,
        visibleLeft,
        visibleRight,
      });
      setPopoverWidth(placement.width);
      setPopoverLeft(placement.left);
      setAlignEnd(placement.alignEnd);
      const visibleTop = Math.max(scrollPortBounds?.top ?? 0, 0) + 8;
      const visibleBottom = Math.min(scrollPortBounds?.bottom ?? window.innerHeight, window.innerHeight) - 8;
      const spaceBelow = Math.max(0, visibleBottom - bounds.bottom - 7);
      const spaceAbove = Math.max(0, bounds.top - visibleTop - 7);
      const measuredPopover = rootRef.current.querySelector<HTMLElement>('.detail-multiselect-popover');
      const { natural, minimum } = measureFilterPopoverHeights(measuredPopover);
      const vertical = getFilterPopoverVerticalPlacement({
        spaceAbove,
        spaceBelow,
        naturalHeight: natural,
        minimumHeight: minimum,
        // 滚动时触发块不能离开可视区。
        scrollRoomDown: scrollPort
          ? Math.min(scrollPort.scrollHeight - scrollPort.clientHeight - scrollPort.scrollTop, Math.max(0, bounds.top - visibleTop))
          : 0,
        scrollRoomUp: scrollPort
          ? Math.min(scrollPort.scrollTop, Math.max(0, visibleBottom - bounds.bottom))
          : 0,
      });
      if (scrollPort && vertical.scrollBy !== 0) scrollPort.scrollTop += vertical.scrollBy;
      setPopoverMaxHeight(vertical.maxHeight);
      setAlignTop(vertical.alignTop);
    };
    updatePopoverPlacement();
    window.addEventListener('resize', updatePopoverPlacement);
    return () => window.removeEventListener('resize', updatePopoverPlacement);
  }, [open, options.length, mergedOptions.length]);

  useLayoutEffect(() => {
    if (!open) return;
    optionSearchInputRef.current?.focus({ preventScroll: true });
  }, [open]);

  const summary = values.length === 0
    ? `全部${label}`
    : values.length === 1
      ? values[0]
      : `已选 ${values.length} 项`;

  const openPopover = () => {
    setDraftValues(values);
    setOptionSearch('');
    setOpen(true);
  };

  const cancelPopover = () => {
    setDraftValues(values);
    setOpen(false);
    restoreFocusRef.current = true;
    triggerRef.current?.focus();
  };

  const applyPopover = () => {
    onChange(draftValues);
    setOpen(false);
    restoreFocusRef.current = true;
    triggerRef.current?.focus();
  };

  // 上面三条关闭路径都同步调了 focus()，但「应用筛选」会触发重新取数，
  // 调用方随即把触发按钮置为 disabled——浏览器不让 disabled 元素持有焦点，
  // 焦点被退回 <body>，取数结束按钮恢复可用时也不会自己回来（T10.128 P1）。
  // 等它重新可聚焦再补一次；只在焦点确实无处安放时补，不抢用户已经移走的焦点。
  useEffect(() => {
    if (open || disabled || !restoreFocusRef.current) return;
    const trigger = triggerRef.current;
    const active = document.activeElement;
    // 焦点已经在触发按钮上：保持待命而不是收工——禁用可能在下一次提交才到，
    // 那时焦点会被浏览器打回 body，还得靠这个标记补回来。
    if (active === trigger) return;
    restoreFocusRef.current = false;
    // 用户自己把焦点移到别处了，不抢。
    if (active && active !== document.body) return;
    trigger?.focus();
  }, [open, disabled]);

  const handleOptionListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const container = optionListRef.current;
    if (!container) return;
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('.detail-option-row:not(:disabled)'));
    if (rows.length === 0) return;
    event.preventDefault();
    const currentIndex = rows.findIndex((row) => row === document.activeElement);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowDown') nextIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, rows.length - 1);
    else if (event.key === 'ArrowUp') nextIndex = currentIndex < 0 ? rows.length - 1 : Math.max(currentIndex - 1, 0);
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = rows.length - 1;
    rows[nextIndex]?.focus();
  };

  return (
    <div ref={rootRef} className={`detail-multiselect${open ? ' is-open' : ''}`}>
      <span className="detail-filter-label">{label}</span>
      <button
        ref={triggerRef}
        className="detail-multiselect-trigger"
        type="button"
        aria-label={`${label}：${summary}`}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => (open ? cancelPopover() : openPopover())}
      >
        <span title={values.join('、')}>{summary}</span>
        {values.length > 0 && <span className="detail-multiselect-count">{values.length}</span>}
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <div
          id={listId}
          className={`detail-multiselect-popover${alignEnd ? ' align-end' : ''}${alignTop ? ' align-top' : ''}`}
          role="dialog"
          aria-label={`${label}多选`}
          aria-describedby={selectionSummaryId}
          style={{
            left: popoverLeft !== null ? `${popoverLeft}px` : undefined,
            right: popoverLeft !== null ? 'auto' : undefined,
            width: popoverWidth !== null ? `${popoverWidth}px` : undefined,
            maxHeight: popoverMaxHeight !== null ? `${popoverMaxHeight}px` : undefined,
          }}
        >
          <label className="detail-option-search">
            <Search className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">搜索{label}</span>
            <input
              ref={optionSearchInputRef}
              value={optionSearch}
              onChange={(event) => setOptionSearch(event.target.value)}
              placeholder={`搜索${label}`}
            />
            {optionSearch && (
              <button type="button" onClick={() => setOptionSearch('')} aria-label={`清除${label}搜索`}>
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </label>
          <div ref={optionListRef} className="detail-option-list tl-scrollbar" onKeyDown={handleOptionListKeyDown}>
            {mergedOptions.length === 0 ? (
              <div className="detail-option-empty" role="status" aria-live="polite">没有匹配的{label}</div>
            ) : mergedOptions.map((option) => {
              const checked = draftValues.includes(option.value);
              const selectionLimitReached = !checked && draftValues.length >= SELECTION_LIMIT;
              return (
                <button
                  key={option.value}
                  className={`detail-option-row${selectionLimitReached ? ' is-disabled' : ''}`}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  disabled={selectionLimitReached}
                  onClick={() => setDraftValues(checked
                    ? draftValues.filter((value) => value !== option.value)
                    : [...draftValues, option.value])}
                >
                  <span className="detail-option-check" aria-hidden="true">{checked && <Check className="h-3.5 w-3.5" />}</span>
                  <span className="detail-option-name" title={option.value}>{option.value}</span>
                  {option.count > 0 && <span className="detail-option-count">{formatNum(option.count)}</span>}
                </button>
              );
            })}
          </div>
          <div className="detail-option-footer">
            <span
              id={selectionSummaryId}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              已选 {draftValues.length} 项（上限 {SELECTION_LIMIT}）· 应用后生效
            </span>
            <div className="detail-option-footer-actions">
              <button type="button" onClick={() => setDraftValues([])}>清空</button>
              <button type="button" onClick={cancelPopover}>取消</button>
              <button type="button" className="detail-option-apply" onClick={applyPopover}>应用筛选</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default FilterMultiSelect;
