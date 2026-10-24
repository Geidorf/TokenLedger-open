import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, LayoutGrid, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { MAX_DASHBOARD_LAYOUTS, MAX_DASHBOARD_LAYOUT_NAME, type DashboardLayout } from '../../utils/dashboardLayout';

interface LayoutSwitcherProps {
  layouts: DashboardLayout[];
  activeId: string;
  onSwitch: (id: string) => void;
}

/** 布局切换：一组单选按钮，方向键在布局间移动并立即切换。 */
export function DashboardLayoutSwitcher({ layouts, activeId, onSwitch }: LayoutSwitcherProps) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  if (layouts.length < 2) return null;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = layouts[(index + step + layouts.length) % layouts.length];
    onSwitch(next.id);
    refs.current.get(next.id)?.focus();
  };
  return (
    <div className="segmented dashboard-layout-switcher" role="radiogroup" aria-label="概览布局">
      {layouts.map((layout, index) => (
        <button
          key={layout.id}
          ref={element => { if (element) refs.current.set(layout.id, element); else refs.current.delete(layout.id); }}
          type="button"
          role="radio"
          aria-checked={layout.id === activeId}
          tabIndex={layout.id === activeId ? 0 : -1}
          onClick={() => onSwitch(layout.id)}
          onKeyDown={event => onKeyDown(event, index)}
        >
          {layout.name}
        </button>
      ))}
    </div>
  );
}

interface LayoutToolbarProps {
  layout: DashboardLayout;
  layoutCount: number;
  onRename: (name: string) => void;
  onAdd: (name: string) => void;
  onDelete: () => void;
  onReset: () => void;
  onDone: () => void;
}

/** 编辑模式的工具条：改名、另存为新布局、删除、恢复默认、完成。 */
export function DashboardLayoutToolbar({ layout, layoutCount, onRename, onAdd, onDelete, onReset, onDone }: LayoutToolbarProps) {
  const nameId = useId();
  const [name, setName] = useState(layout.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const doneRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { setName(layout.name); setConfirmDelete(false); }, [layout.id, layout.name]);
  const commitName = () => {
    if (name.trim() && name.trim() !== layout.name) onRename(name);
    else setName(layout.name);
  };
  const full = layoutCount >= MAX_DASHBOARD_LAYOUTS;
  return (
    <div className="dashboard-layout-toolbar" role="region" aria-label="编辑概览布局">
      <div className="dashboard-layout-toolbar-title">
        <LayoutGrid aria-hidden="true" />
        <label htmlFor={nameId}>布局名称</label>
        <input
          id={nameId}
          className="dashboard-layout-name"
          value={name}
          maxLength={MAX_DASHBOARD_LAYOUT_NAME}
          onChange={event => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); commitName(); }
            if (event.key === 'Escape') { event.preventDefault(); setName(layout.name); }
          }}
        />
      </div>
      <p className="dashboard-layout-toolbar-hint">拖动卡片标题排序，或聚焦标题按空格拿起、方向键移动。改动即时保存在本机。</p>
      <div className="dashboard-layout-toolbar-actions">
        <button type="button" className="ghost-inline" disabled={full}
          title={full ? `最多保存 ${MAX_DASHBOARD_LAYOUTS} 套布局` : undefined}
          onClick={() => onAdd(`${layout.name} 副本`)}>
          <Plus aria-hidden="true" />另存为新布局
        </button>
        {confirmDelete
          ? <span className="dashboard-layout-confirm" role="group" aria-label={`确认删除布局：${layout.name}`}>
            <button type="button" className="danger-inline" onClick={() => { setConfirmDelete(false); onDelete(); doneRef.current?.focus(); }}>确认删除</button>
            <button type="button" className="ghost-inline" onClick={() => setConfirmDelete(false)}>取消</button>
          </span>
          : <button type="button" className="ghost-inline" disabled={layoutCount <= 1}
            title={layoutCount <= 1 ? '至少保留一套布局' : undefined}
            onClick={() => setConfirmDelete(true)}>
            <Trash2 aria-hidden="true" />删除布局
          </button>}
        <button type="button" className="ghost-inline" onClick={onReset}><RotateCcw aria-hidden="true" />恢复默认</button>
        <button ref={doneRef} type="button" className="secondary-inline" onClick={onDone}><Check aria-hidden="true" />完成</button>
      </div>
    </div>
  );
}
