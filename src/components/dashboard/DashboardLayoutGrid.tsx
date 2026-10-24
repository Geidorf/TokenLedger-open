import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Eye, EyeOff, GripVertical } from 'lucide-react';
import {
  DASHBOARD_CARDS,
  DASHBOARD_CARD_WIDTH_LABELS,
  type DashboardCardId,
  type DashboardCardWidth,
  type DashboardLayoutCard,
} from '../../utils/dashboardLayout';

interface DashboardLayoutGridProps {
  /** 当前布局里能渲染的卡片，已按布局顺序排好。 */
  cards: DashboardLayoutCard[];
  editing: boolean;
  /** 卡片内容；返回 null 表示这张卡片在当前范围或口径下没有内容。 */
  renderCard: (id: DashboardCardId) => ReactNode;
  /** 编辑时没有内容的卡片显示的说明。 */
  emptyNote: (id: DashboardCardId) => string;
  onMove: (id: DashboardCardId, targetIndex: number) => void;
  onVisible: (id: DashboardCardId, visible: boolean) => void;
  onWidth: (id: DashboardCardId, width: DashboardCardWidth) => void;
  /** 查看时一张有内容的卡片都没有（例如只留了热力图又切到今日）时，空状态里的「编辑布局」。 */
  onEdit?: () => void;
}

const WIDTH_SHORT: Record<DashboardCardWidth, string> = { full: '全', half: '½', third: '⅓' };

/**
 * 概览卡片网格。查看时只排卡片；编辑时每张卡片上方多一条工具条：拖动手柄、宽度、显隐。
 * 手柄两种用法：鼠标或触控按住拖动；键盘聚焦后按空格或回车拿起，方向键移动，再按一次放下，Esc 放回原处。
 */
export function DashboardLayoutGrid({ cards, editing, renderCard, emptyNote, onMove, onVisible, onWidth, onEdit }: DashboardLayoutGridProps) {
  const [dropTarget, setDropTarget] = useState<{ id: DashboardCardId; after: boolean; axis: 'x' | 'y' } | null>(null);
  const [draggingId, setDraggingId] = useState<DashboardCardId | null>(null);
  const [grabbed, setGrabbed] = useState<{ id: DashboardCardId; from: number } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const handleRefs = useRef(new Map<DashboardCardId, HTMLButtonElement>());
  const refocusRef = useRef<DashboardCardId | null>(null);
  // 「至少保留一张」按当前真有内容的可见卡片算：热力图在短范围、Context 没有网关构成时都不渲染。
  const contents = new Map(cards.map(item => [item.id, renderCard(item.id)]));
  const shownCount = cards.filter(item => item.visible && contents.get(item.id) !== null).length;

  const order = cards.map(item => item.id);

  // 键盘移动后 React 会挪动 DOM 节点，焦点可能丢；挪完把焦点放回同一个手柄。
  useLayoutEffect(() => {
    const id = refocusRef.current;
    if (!id) return;
    refocusRef.current = null;
    const handle = handleRefs.current.get(id);
    if (handle && document.activeElement !== handle) handle.focus();
  });

  const labelOf = (id: DashboardCardId) => DASHBOARD_CARDS[id].label;
  const positionText = (id: DashboardCardId, list: readonly DashboardCardId[] = order) => `第 ${list.indexOf(id) + 1} 张，共 ${list.length} 张`;

  const moveBy = (id: DashboardCardId, target: number) => {
    const current = order.indexOf(id);
    const to = Math.max(0, Math.min(order.length - 1, target));
    if (to === current) return;
    const next = [...order];
    next.splice(current, 1);
    next.splice(to, 0, id);
    refocusRef.current = id;
    onMove(id, to);
    setAnnouncement(`${labelOf(id)}：${positionText(id, next)}`);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, id: DashboardCardId) => {
    const index = order.indexOf(id);
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (grabbed?.id === id) {
        setGrabbed(null);
        setAnnouncement(`已放下${labelOf(id)}：${positionText(id)}`);
      } else {
        setGrabbed({ id, from: index });
        setAnnouncement(`已拿起${labelOf(id)}，${positionText(id)}。方向键移动，空格或回车放下，Esc 取消。`);
      }
      return;
    }
    if (event.key === 'Escape' && grabbed?.id === id) {
      event.preventDefault();
      event.stopPropagation();
      if (grabbed.from !== index) {
        refocusRef.current = id;
        onMove(id, grabbed.from);
      }
      setGrabbed(null);
      setAnnouncement(`已取消移动，${labelOf(id)}回到第 ${grabbed.from + 1} 张`);
      return;
    }
    if (grabbed?.id !== id) return;
    const step = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1
      : event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : 0;
    if (step) { event.preventDefault(); moveBy(id, index + step); return; }
    if (event.key === 'Home') { event.preventDefault(); moveBy(id, 0); return; }
    if (event.key === 'End') { event.preventDefault(); moveBy(id, order.length - 1); }
  };

  const handleBlur = (id: DashboardCardId) => {
    // 移动途中节点被挪动造成的失焦不算放下。
    if (refocusRef.current === id) return;
    if (grabbed?.id === id) setGrabbed(null);
  };

  // 拖动时卡片不动，只在目标卡片边上画落点；松手才重排，命中测试不会被移动中的卡片干扰。
  const startPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: DashboardCardId) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const grid = handle.closest('.dashboard-layout-grid');
    let target: { id: DashboardCardId; after: boolean; axis: 'x' | 'y' } | null = null;
    setGrabbed(null);
    setDraggingId(id);
    const onPointerMove = (move: PointerEvent) => {
      const elements = Array.from(grid?.querySelectorAll<HTMLElement>('[data-layout-card]') ?? []);
      const hit = elements.find(element => {
        const rect = element.getBoundingClientRect();
        return move.clientX >= rect.left && move.clientX <= rect.right && move.clientY >= rect.top && move.clientY <= rect.bottom;
      });
      if (!hit) return;
      // 拖回自己身上：放弃之前的落点，松手不改顺序。
      if (hit.dataset.layoutCard === id) {
        if (target) { target = null; setDropTarget(null); }
        return;
      }
      const rect = hit.getBoundingClientRect();
      // 按实际排版判断：独占一行（含窄窗口下退回全宽的半宽卡片）按上下半边，和别的卡片并排时按左右半边。
      const gridWidth = grid?.getBoundingClientRect().width ?? rect.width;
      const axis: 'x' | 'y' = rect.width >= gridWidth * 0.9 ? 'y' : 'x';
      const after = axis === 'x' ? move.clientX > rect.left + rect.width / 2 : move.clientY > rect.top + rect.height / 2;
      const next = { id: hit.dataset.layoutCard as DashboardCardId, after, axis };
      if (target && target.id === next.id && target.after === next.after) return;
      target = next;
      setDropTarget(next);
    };
    const finish = (commit: boolean) => {
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);
      handle.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onEscape, true);
      setDropTarget(null);
      setDraggingId(null);
      if (!commit || !target) return;
      const rest = order.filter(item => item !== id);
      const to = rest.indexOf(target.id) + (target.after ? 1 : 0);
      if (to === order.indexOf(id)) return;
      rest.splice(to, 0, id);
      onMove(id, to);
      setAnnouncement(`已把${labelOf(id)}移到${positionText(id, rest)}`);
    };
    const onPointerUp = () => finish(true);
    const onPointerCancel = () => finish(false);
    const onEscape = (key: KeyboardEvent) => {
      if (key.key !== 'Escape') return;
      key.preventDefault();
      key.stopPropagation();
      finish(false);
    };
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onEscape, true);
  };

  return (
    <div className="dashboard-layout" data-editing={editing || undefined}>
      <div className="dashboard-layout-grid" role={editing ? 'list' : undefined} aria-label={editing ? '概览卡片' : undefined}>
        {cards.map(item => {
          const { id } = item;
          const content = contents.get(id) ?? null;
          if (!editing && (!item.visible || content === null)) return null;
          const label = labelOf(id);
          const widths = DASHBOARD_CARDS[id].widths;
          const lastVisible = item.visible && content !== null && shownCount <= 1;
          return (
            <div key={id} className="dashboard-layout-card" data-layout-card={id} data-width={item.width}
              data-hidden={!item.visible || undefined} data-dragging={draggingId === id || undefined}
              data-grabbed={grabbed?.id === id || undefined}
              data-drop={dropTarget?.id === id ? (dropTarget.after ? 'after' : 'before') : undefined}
              data-drop-axis={dropTarget?.id === id ? dropTarget.axis : undefined} role={editing ? 'listitem' : undefined}>
              {editing && (
                <div className="dashboard-layout-card-bar">
                  <button
                    type="button"
                    className="dashboard-layout-handle"
                    ref={element => { if (element) handleRefs.current.set(id, element); else handleRefs.current.delete(id); }}
                    aria-label={`移动卡片：${label}，${positionText(id)}`}
                    aria-pressed={grabbed?.id === id}
                    aria-describedby="dashboard-layout-handle-hint"
                    onPointerDown={event => startPointerDrag(event, id)}
                    onKeyDown={event => handleKeyDown(event, id)}
                    onBlur={() => handleBlur(id)}
                  >
                    <GripVertical aria-hidden="true" />
                    <span>{label}</span>
                  </button>
                  {item.visible && widths.length > 1 && (
                    <div className="segmented dashboard-layout-width" role="group" aria-label={`${label}宽度`}>
                      {widths.map(width => (
                        <button key={width} type="button" aria-pressed={item.width === width}
                          aria-label={DASHBOARD_CARD_WIDTH_LABELS[width]} title={DASHBOARD_CARD_WIDTH_LABELS[width]}
                          onClick={() => onWidth(id, width)}>
                          {WIDTH_SHORT[width]}
                        </button>
                      ))}
                    </div>
                  )}
                  <button
                    type="button"
                    className="dashboard-layout-visibility"
                    disabled={lastVisible}
                    title={lastVisible ? '至少保留一张卡片' : undefined}
                    aria-label={lastVisible ? `至少保留一张卡片：${label}` : `${item.visible ? '隐藏' : '显示'}卡片：${label}`}
                    onClick={() => onVisible(id, !item.visible)}
                  >
                    {item.visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                    <span>{item.visible ? '隐藏' : '显示'}</span>
                  </button>
                </div>
              )}
              {editing && !item.visible
                ? <p className="dashboard-layout-note">已隐藏</p>
                : content === null
                  ? <p className="dashboard-layout-note">{emptyNote(id)}</p>
                  : <div className="dashboard-layout-card-body" inert={editing || undefined}>{content}</div>}
            </div>
          );
        })}
      </div>
      {!editing && shownCount === 0 && (
        <section className="panel empty-panel dashboard-layout-empty" aria-label="当前布局没有可显示的卡片">
          <div>
            <h2>当前布局在这个范围下没有可显示的卡片</h2>
            <p>留下的卡片只在其他范围或有网关记录时才有内容。可以换个范围，或在编辑布局里显示更多卡片。</p>
          </div>
          {onEdit && <button type="button" className="secondary-inline" onClick={onEdit}>编辑布局</button>}
        </section>
      )}
      {editing && <p id="dashboard-layout-handle-hint" className="sr-only">按住拖动，或按空格拿起后用方向键移动，再按空格放下。</p>}
      <div className="sr-only" role="status" aria-live="assertive">{announcement}</div>
    </div>
  );
}
