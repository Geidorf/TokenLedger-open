import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import { DASHBOARD_CARD_WIDTH_LABELS, type DashboardCardId, type DashboardCardWidth } from '../utils/dashboardLayout';
import '../styles/dashboardDisplayPreferences.css';

export interface DisplayPreferenceItem {
  id: string;
  label: string;
  visible: boolean;
  /** 只有首页卡片有宽度。 */
  width?: DashboardCardWidth;
  widths?: readonly DashboardCardWidth[];
}

interface DashboardDisplayPreferencesDialogProps {
  open: boolean;
  modules: DisplayPreferenceItem[];
  sources: DisplayPreferenceItem[];
  onClose: () => void;
  onReset: () => void;
  onModuleVisible: (id: DashboardCardId, visible: boolean) => void;
  onModuleMove: (id: DashboardCardId, direction: -1 | 1) => void;
  onModuleWidth: (id: DashboardCardId, width: DashboardCardWidth) => void;
  onSourceVisible: (id: string, visible: boolean) => void;
  onSourceMove: (id: string, direction: -1 | 1) => void;
}

function PreferenceRows({ kind, items, onVisible, onMove, onWidth }: {
  kind: '卡片' | '来源'; items: DisplayPreferenceItem[];
  onVisible: (id: string, visible: boolean) => void; onMove: (id: string, direction: -1 | 1) => void;
  onWidth?: (id: string, width: DashboardCardWidth) => void;
}) {
  const visibleCount = items.filter(item => item.visible).length;
  const keep = `至少保留一${kind === '卡片' ? '张' : '个'}${kind}可见`;
  return <div className="dashboard-preference-list" aria-label={`${kind}顺序`}>
    {items.map((item, index) => <div className="dashboard-preference-row" key={item.id}>
      <button type="button" className="dashboard-preference-toggle" role="switch" aria-checked={item.visible}
        disabled={item.visible && visibleCount === 1}
        title={item.visible && visibleCount === 1 ? keep : undefined}
        aria-label={item.visible && visibleCount === 1 ? `${keep}：${item.label}` : `${item.visible ? '隐藏' : '显示'}${kind}：${item.label}`}
        onClick={() => onVisible(item.id, !item.visible)}>
        <span aria-hidden="true">{item.visible ? '显示' : '隐藏'}</span>
      </button>
      <span className="dashboard-preference-label">{item.label}</span>
      {onWidth && item.widths && item.widths.length > 1 && item.visible && <select className="dashboard-preference-width"
        aria-label={`${kind}宽度：${item.label}`} value={item.width} onChange={event => onWidth(item.id, event.target.value as DashboardCardWidth)}>
        {item.widths.map(width => <option key={width} value={width}>{DASHBOARD_CARD_WIDTH_LABELS[width]}</option>)}
      </select>}
      <div className="dashboard-preference-move">
        <button type="button" aria-label={`上移${kind}：${item.label}`} disabled={index === 0} onClick={() => onMove(item.id, -1)}><ArrowUp /></button>
        <button type="button" aria-label={`下移${kind}：${item.label}`} disabled={index === items.length - 1} onClick={() => onMove(item.id, 1)}><ArrowDown /></button>
      </div>
    </div>)}
  </div>;
}

export function DashboardDisplayPreferencesDialog(props: DashboardDisplayPreferencesDialogProps) {
  const { open, onClose } = props;
  const [activePanel, setActivePanel] = useState<'modules' | 'sources'>('modules');
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef<Record<'modules' | 'sources', HTMLButtonElement | null>>({ modules: null, sources: null });
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onClose(); return; }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') || []);
      if (!focusable.length) return;
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      if ((!event.shiftKey && index === focusable.length - 1) || (event.shiftKey && index <= 0)) {
        event.preventDefault();
        focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); previous?.focus(); };
  }, [open, onClose]);
  const selectPanel = (panel: 'modules' | 'sources', focus = false) => {
    if (focus) tabRefs.current[panel]?.focus();
    setActivePanel(panel);
  };
  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    selectPanel(activePanel === 'modules' ? 'sources' : 'modules', true);
  };
  if (!open) return null;
  const dialog = <div className="modal-overlay dashboard-preferences-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="modal-content dashboard-preferences-dialog" role="dialog" aria-modal="true" aria-labelledby="dashboard-preferences-title" tabIndex={-1}>
      <header className="modal-header dashboard-preferences-header"><div><SlidersHorizontal aria-hidden="true" /><h2 id="dashboard-preferences-title">调整显示</h2><p>仅调整本机看板的显示与顺序，不会停止采集或额度读取。</p></div>
        <button ref={closeRef} type="button" className="modal-close" aria-label="关闭调整显示" onClick={onClose}><X /></button></header>
      <div className="dashboard-preferences-tabs" role="tablist" aria-label="调整显示分类">
        <button ref={element => { tabRefs.current.modules = element; }} type="button" role="tab" id="dashboard-preferences-modules-tab"
          aria-selected={activePanel === 'modules'} aria-controls="dashboard-preferences-modules-panel" tabIndex={activePanel === 'modules' ? 0 : -1}
          onClick={() => selectPanel('modules')} onKeyDown={handleTabKeyDown}>首页卡片</button>
        <button ref={element => { tabRefs.current.sources = element; }} type="button" role="tab" id="dashboard-preferences-sources-tab"
          aria-selected={activePanel === 'sources'} aria-controls="dashboard-preferences-sources-panel" tabIndex={activePanel === 'sources' ? 0 : -1}
          onClick={() => selectPanel('sources')} onKeyDown={handleTabKeyDown}>额度来源</button>
      </div>
      <section className="dashboard-preferences-panel" role="tabpanel" id={`dashboard-preferences-${activePanel}-panel`}
        aria-labelledby={`dashboard-preferences-${activePanel}-tab`}>
        {activePanel === 'modules' ? <><h3>首页卡片</h3><p className="dashboard-preferences-note">调整的是当前布局；在概览点「编辑布局」可以直接拖动卡片、另存多套布局。</p><PreferenceRows kind="卡片" items={props.modules} onVisible={(id, visible) => props.onModuleVisible(id as DashboardCardId, visible)} onMove={(id, direction) => props.onModuleMove(id as DashboardCardId, direction)} onWidth={(id, width) => props.onModuleWidth(id as DashboardCardId, width)} /></>
          : <><h3>额度来源</h3>{props.sources.length ? <PreferenceRows kind="来源" items={props.sources} onVisible={props.onSourceVisible} onMove={props.onSourceMove} /> : <p className="dashboard-preferences-empty">暂无额度来源；新来源会默认显示在列表末尾。</p>}</>}
      </section>
      <footer className="dashboard-preferences-footer"><button type="button" className="ghost-inline" onClick={props.onReset}><RotateCcw />恢复默认</button><button type="button" className="secondary-inline" onClick={onClose}>完成</button></footer>
    </section>
  </div>;

  return typeof document !== 'undefined' ? createPortal(dialog, document.body) : dialog;
}
