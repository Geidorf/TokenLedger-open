import { Info } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { placeCostHelp } from './CostHelpButton';
import '../styles/infoTip.css';

interface InfoTipProps {
  /** 按钮的可访问名称，例如「趋势口径说明」。 */
  label: string;
  children: ReactNode;
  className?: string;
}

/**
 * 报表的 ⓘ 悬停提示（U-102）：解释性文字不再铺在卡片上。按钮可 Tab 聚焦，悬停或聚焦时显示，
 * Escape 收起；提示收起时以 `hidden` 留在 DOM 里，`aria-describedby` 引用隐藏节点照样能算出描述，
 * 读屏聚焦按钮即可读到。
 * 提示按视口定位（fixed），不会被卡片的 overflow 裁掉。
 */
export function InfoTip({ label, children, className }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<CSSProperties>();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const tipId = useId();

  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(undefined);
      return undefined;
    }
    const place = () => {
      const button = buttonRef.current;
      const tip = tipRef.current;
      if (!button || !tip) return;
      setPlacement(placeCostHelp(
        button.getBoundingClientRect(),
        tip.offsetWidth,
        tip.offsetHeight,
        document.documentElement.clientWidth || window.innerWidth,
        document.documentElement.clientHeight || window.innerHeight,
      ));
    };
    place();
    window.addEventListener('resize', hide);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('resize', hide);
      window.removeEventListener('scroll', hide, true);
    };
  }, [open, hide]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      hide();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [open, hide]);

  return (
    <span className={`info-tip${className ? ` ${className}` : ''}`} onMouseEnter={show} onMouseLeave={hide}>
      <button
        ref={buttonRef}
        type="button"
        className="info-tip-button"
        aria-label={label}
        aria-describedby={tipId}
        onFocus={show}
        onBlur={hide}
        onClick={() => setOpen((value) => !value)}
      >
        <Info aria-hidden="true" />
      </button>
      <span
        ref={tipRef}
        id={tipId}
        role="tooltip"
        className="info-tip-bubble"
        hidden={!open}
        data-open={open && placement ? 'true' : undefined}
        style={placement}
      >
        {children}
      </span>
    </span>
  );
}

export default InfoTip;
