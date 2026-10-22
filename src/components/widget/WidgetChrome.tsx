import type { LucideIcon } from 'lucide-react';
import { ExternalLink, RefreshCw, Settings, X } from 'lucide-react';
import { useSegmentedIndicator } from '../../hooks/useSegmentedIndicator';
import { WIDGET_RANGES, type WidgetRange } from '../../utils/widgetConfig';

/**
 * 两块挂件的操作件（T10.192，方案 §6.3、§6.4、§6.6）：
 * - 托盘挂件顶栏：范围分段 + 刷新、打开主窗口、设置、收起四个图标；
 * - 桌面小组件悬停工具条：平时不显示，指针移入才在右上角淡入（减弱动效时直接出现）。
 * 视觉 30px，命中区 44×44（GLB-03）：图标之间留 14px，扩出来的命中区左右相接、互不重叠。
 * `staticPreview` 给设置页预览用：画成一样，但全是不可聚焦、不可点的 span。
 */

export interface WidgetActions {
  refresh: () => void;
  openMain: () => void;
  openSettings: () => void;
  /** 托盘挂件：收起；桌面小组件：从桌面移除。 */
  close: () => void;
}

interface ActionSpec {
  key: string;
  label: string;
  icon: LucideIcon;
  run: keyof WidgetActions;
}

function actionSpecs(closeLabel: string): ActionSpec[] {
  return [
    { key: 'refresh', label: '刷新扫描', icon: RefreshCw, run: 'refresh' },
    { key: 'open', label: '打开主窗口', icon: ExternalLink, run: 'openMain' },
    { key: 'settings', label: '打开设置', icon: Settings, run: 'openSettings' },
    { key: 'close', label: closeLabel, icon: X, run: 'close' },
  ];
}

function IconButtons({ actions, closeLabel, busy, staticPreview }: {
  actions: WidgetActions | null;
  closeLabel: string;
  busy: boolean;
  staticPreview: boolean;
}) {
  return (
    <>
      {actionSpecs(closeLabel).map((spec) => {
        const glyph = <spec.icon size={16} strokeWidth={2} aria-hidden="true" className={spec.key === 'refresh' && busy ? 'animate-spin' : undefined} />;
        if (staticPreview || !actions) {
          return <span key={spec.key} className="wl-icon-btn">{glyph}</span>;
        }
        return (
          <button
            key={spec.key}
            type="button"
            className="wl-icon-btn"
            aria-label={spec.label}
            title={spec.label}
            disabled={spec.key === 'refresh' && busy}
            onClick={() => actions[spec.run]()}
          >
            {glyph}
          </button>
        );
      })}
    </>
  );
}

export function TrayTopBar({ range, showRange, onRange, actions, busy = false, staticPreview = false }: {
  range: WidgetRange;
  /** 「额度总览」只看额度，范围对它没有意义：不画分段，而不是留一组点了没反应的按钮。 */
  showRange: boolean;
  onRange?: (range: WidgetRange) => void;
  actions: WidgetActions | null;
  busy?: boolean;
  staticPreview?: boolean;
}) {
  const indicatorRef = useSegmentedIndicator<HTMLDivElement>();
  return (
    <div className="wl-bar">
      {showRange ? (
        staticPreview ? (
          <div className="wl-seg">
            {WIDGET_RANGES.map((item) => (
              <span key={item.id} className="wl-seg-btn" data-active={range === item.id ? 'true' : undefined}>{item.label}</span>
            ))}
          </div>
        ) : (
          <div className="wl-seg tl-seg" role="group" aria-label="统计范围" ref={indicatorRef}>
            {WIDGET_RANGES.map((item) => (
              <button
                key={item.id}
                type="button"
                className="wl-seg-btn"
                aria-pressed={range === item.id}
                onClick={() => onRange?.(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )
      ) : <span />}
      <div className="wl-icons">
        <IconButtons actions={actions} closeLabel="隐藏托盘挂件" busy={busy} staticPreview={staticPreview} />
      </div>
    </div>
  );
}

/**
 * 桌面小组件的悬停工具条。平时 `inert` + `aria-hidden`：看不见、点不到、读屏也不读；
 * 指针移入后淡入。它盖住“更新于”那一行（那一行同时淡出），不盖大数字。
 */
export function DesktopToolbar({ shown, at, actions, busy = false }: {
  shown: boolean;
  /** 盖在哪一行上：右上角的“更新于”（`top`）或「额度与用量」右栏底部的那一行（`bottom`）。 */
  at: 'top' | 'bottom';
  actions: WidgetActions;
  busy?: boolean;
}) {
  return (
    <div className="wl-toolbar" data-shown={shown ? 'true' : 'false'} data-at={at} inert={!shown} aria-hidden={shown ? undefined : true}>
      <IconButtons actions={actions} closeLabel="从桌面移除" busy={busy} staticPreview={false} />
    </div>
  );
}
