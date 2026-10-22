import { Info } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { ESTIMATED_COST_HELP, ESTIMATED_COST_LABEL } from '../utils/costCopy';
import type { DataScope } from '../types';
import '../styles/costHelp.css';

const EDGE = 8;
const GAP = 8;

// 云端汇总把没有费用的记录按 0 计入（方案 §2.1 末条），只在云端范围出现，避免误导本机用户
// （T10.186 评审待定点 4）。这句话只描述统计口径，不出现「金额」字样，守卫不需要额外放行。
const CLOUD_ZERO_COALESCE_NOTE = '云端汇总把没有费用的记录按 0 计入。';

interface CostHelpButtonProps {
  /** 云端范围额外补一句零值合计说明；本机范围或未传都不显示。 */
  scope?: DataScope;
}

/** 弹层放在按钮下方（放不下且上方够时放上方），左右夹在视口内。 */
export function placeCostHelp(
  anchor: Pick<DOMRect, 'left' | 'top' | 'bottom'>,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): Pick<CSSProperties, 'left' | 'top'> {
  const left = Math.min(Math.max(EDGE, anchor.left - 12), Math.max(EDGE, viewportWidth - EDGE - width));
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - height;
  const top = below + height <= viewportHeight - EDGE || above < EDGE
    ? Math.max(EDGE, Math.min(below, viewportHeight - EDGE - height))
    : above;
  return { left: Math.round(left), top: Math.round(top) };
}

/**
 * 「预估费用」标签旁的 ⓘ（T10.154 §4.2）：图标 18px、可点区 44px，点按打开非模态说明弹层，
 * Escape 关闭并把焦点还给按钮。弹层挂到所在对话框（专属看板）或 body，避免被 KPI 卡的
 * overflow 裁掉；在对话框里时仍属于对话框，读屏不会因 aria-modal 读不到它。
 */
export function CostHelpButton({ scope }: CostHelpButtonProps = {}) {
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [placement, setPlacement] = useState<CSSProperties>();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef(false);
  const popoverId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  const toggle = () => {
    if (open) {
      close(true);
      return;
    }
    const button = buttonRef.current;
    setContainer(button?.closest<HTMLElement>('[role="dialog"]') ?? document.body);
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(undefined);
      return undefined;
    }
    const place = () => {
      const button = buttonRef.current;
      const popover = popoverRef.current;
      if (!button || !popover) return;
      setPlacement(placeCostHelp(
        button.getBoundingClientRect(),
        popover.offsetWidth,
        popover.offsetHeight,
        document.documentElement.clientWidth || window.innerWidth,
        document.documentElement.clientHeight || window.innerHeight,
      ));
    };
    // resize / scroll 触发的重算：锚点完全滚出视口（上方或下方）时收起弹层，不然它会被夹在
    // 视口边缘、和锚点脱节（T10.186 评审 P3-5）。只在这里检查，不影响刚打开时的首次定位——
    // 首次定位时按钮必然可见（用户刚点了它），不该被 jsdom 等环境下未布局的零矩形误判。
    // 焦点原本在弹层里时还给按钮（`preventScroll` 保证不把页面拉回按钮，不是「强行拉回」）；
    // 焦点本就不在弹层里（比如还没轮到下面那个效果把焦点移进去）就不用管（T10.197 评审 P3-3）。
    const reposition = () => {
      const button = buttonRef.current;
      if (!button) return;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const anchor = button.getBoundingClientRect();
      if (anchor.bottom <= 0 || anchor.top >= viewportHeight) {
        const hadFocusInside = popoverRef.current?.contains(document.activeElement) ?? false;
        close(false);
        if (hadFocusInside) button.focus({ preventScroll: true });
        return;
      }
      place();
    };
    place();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, container, close]);

  // 焦点只在弹层真正定位、可见之后才移入：`open` 变 true 的第一帧弹层仍是 `visibility: hidden`
  // （上面那个效果还没算出 `placement`），这时调 focus() 在真实浏览器（Chrome/WebView2）里是空
  // 操作，焦点会一直留在按钮上，Tab/Shift+Tab 处理形同虚设（T10.197 评审 P2-1）。`focusedRef`
  // 保证一次打开只聚焦一次，不会在 resize/scroll 触发的重新定位时反复抢焦点。
  useLayoutEffect(() => {
    if (open && placement && !focusedRef.current) {
      focusedRef.current = true;
      popoverRef.current?.focus({ preventScroll: true });
    }
    if (!open) focusedRef.current = false;
  }, [open, placement]);

  useEffect(() => {
    if (!open) return undefined;
    // 捕获阶段处理 Escape 并停止传播：专属看板在 document 上用 Escape 关闭整个弹窗，这里只关说明。
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (buttonRef.current?.contains(target) || popoverRef.current?.contains(target))) return;
      close(false);
    };
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [open, close]);

  // Tab 离开弹层：先把焦点放回按钮。普通 Tab 交给浏览器的默认动作，从按钮继续往后走一格；
  // Shift+Tab 到此为止（阻止默认动作），焦点停在按钮上，不再多跳一格到按钮之前的元素
  // （T10.186 评审 P3-5）。这段处理只有焦点先进了弹层才摸得到——上面的深入焦点效果修好后
  // （T10.197 评审 P2-1），打开弹层后焦点就在这里，Tab/Shift+Tab 才会真的触发它。
  const handlePopoverKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    close(true);
    if (event.shiftKey) event.preventDefault();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="cost-help-button"
        aria-label={`${ESTIMATED_COST_LABEL}说明`}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        title={`${ESTIMATED_COST_LABEL}说明`}
        onClick={toggle}
      >
        <Info aria-hidden="true" />
      </button>
      {open && container && createPortal(
        <div
          ref={popoverRef}
          id={popoverId}
          className="cost-help-popover"
          role="dialog"
          aria-label={`${ESTIMATED_COST_LABEL}说明`}
          tabIndex={-1}
          style={placement ?? { visibility: 'hidden' }}
          onKeyDown={handlePopoverKeyDown}
        >
          <p><strong>{ESTIMATED_COST_LABEL}</strong>：{ESTIMATED_COST_HELP}</p>
          {scope === 'cloud' && <p>{CLOUD_ZERO_COALESCE_NOTE}</p>}
        </div>,
        container,
      )}
    </>
  );
}

export default CostHelpButton;
