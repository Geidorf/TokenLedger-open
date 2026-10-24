import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AppSettings, StatsData } from '../types';
import { parseStatsDataContract } from '../utils/contracts/statsQuery';
import {
  DEFAULT_WIDGET_CONFIG,
  resolveWidgetTheme,
  widgetConfigFromSettings,
  type WidgetConfig,
  type WidgetRange,
} from '../utils/widgetConfig';
import { buildCardModel, buildCardQuota, type CardTheme, type WidgetQuotaRead } from './widget/cardModel';
import { LedgerCard } from './widget/LedgerCard';
import { RoutingCard } from './widget/RoutingCard';
import { PanelCard, type PanelToggleTarget, type TrayPanelStatus } from './widget/PanelCard';
import { failedWidgetQuota, readWidgetQuota } from './widget/quotaRead';
import { DesktopToolbar, TrayTopBar, type WidgetActions } from './widget/WidgetChrome';
import { toExternalSnapshot, useRoutingLive } from '../features/gateway/useRoutingLive';
import type { PeerLiveSnapshot } from '../hooks/usePeerLive';
import type { RoutingFeed } from '../features/gateway/types';
import '../styles/widget.css';

/**
 * 桌面挂件（REQ-SHELL-03）。独立窗口里的一屏只读视图：不挂主看板的 hooks，
 * 直接复用缓存统计与本机额度命令，订阅调度器的 `stats-updated`。
 *
 * 同一个视图有两种形态（T10.110）：托盘弹层（默认，指向托盘图标即显示、移开收起，
 * 指针进出要上报给原生侧）与长驻桌面层的小组件（`?mode=desktop`）。
 * 两种形态各自持有一份内容配置（T10.124，见 `utils/widgetConfig.ts`）：板式、主题、默认范围与钉住的额度来源。
 *
 * 画的是方向 B「账本圆环」卡片（T10.192，T10.190 方案 §5.2、§6.3、§6.4、§6.6；卡片与四种板式在
 * `components/widget/`）。托盘挂件顶部一条范围分段 + 四个图标；桌面小组件平时没有任何按钮，
 * 指针移入才在右上角淡入工具条，其余整张卡都是拖动区。窗口尺寸、透明与圆角由 T10.193 按 §6.4、§6.5 做，
 * 在那之前窗口仍是 340×440，卡片按宽度自适应。
 */

export type { WidgetRange } from '../utils/widgetConfig';
export type WidgetMode = 'popover' | 'desktop';

/** 挂件窗口的形态：托盘弹层（默认）或桌面小组件（URL 带 `mode=desktop`）。 */
export function readWidgetMode(search: string = window.location.search): WidgetMode {
  return new URLSearchParams(search).get('mode') === 'desktop' ? 'desktop' : 'popover';
}

const VISIBLE_RECONCILE_MS = 5 * 60 * 1000;
/** 「托盘面板」看得见时多久重读一次开关与网关状态（网关可能在别处被开关）。 */
const PANEL_STATUS_POLL_MS = 5_000;

/** 「实时路由」板式的数据：挂件窗口只被授权读这一条已脱敏的网关视图。 */
const readRoutingFeed = () => invoke<RoutingFeed>('gateway_routing_feed', { limit: 30 });
// 外部本机网关的同一份脱敏快照（固定默认端口）；没运行时 reachable=false，舞台不画它。
const readExternalFeed = async () => toExternalSnapshot(await invoke<PeerLiveSnapshot>('gateway_external_feed'));

interface WidgetSnapshot {
  stats: StatsData;
  range: WidgetRange;
  /** null = 额度还在读（或这个板式不画额度）；额度慢到几十秒也不许挡住本机统计的首屏。 */
  quota: WidgetQuotaRead | null;
  loadedAt: Date;
}

function prefersLightScheme(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
}

export function WidgetView({ mode: modeProp }: { mode?: WidgetMode } = {}) {
  const [mode] = useState<WidgetMode>(() => modeProp ?? readWidgetMode());
  const [config, setConfig] = useState<WidgetConfig>(() => ({ ...DEFAULT_WIDGET_CONFIG }));
  const [configReady, setConfigReady] = useState(false);
  // 顶栏的范围分段是本次会话的临时覆盖，设置里的「默认范围」才是每次打开的起点。
  const [rangeOverride, setRangeOverride] = useState<WidgetRange | null>(null);
  const [snapshot, setSnapshot] = useState<WidgetSnapshot | null>(null);
  const [errors, setErrors] = useState<Partial<Record<WidgetRange, string>>>({});
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [theme, setTheme] = useState<CardTheme>(() => resolveWidgetTheme(DEFAULT_WIDGET_CONFIG.theme, prefersLightScheme()));
  // 桌面小组件：指针在卡片上时才显示工具条（U-18）。
  const [hovered, setHovered] = useState(false);
  const generation = useRef(0);
  const lastLoadedAt = useRef(0);
  const layout = config.layout;
  // 「托盘面板」只看今日：范围分段不画，统计也固定读今日。
  const range = layout === 'panel' ? 'today' : rangeOverride ?? config.range;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const [panelStatus, setPanelStatus] = useState<TrayPanelStatus | null>(null);
  const [panelPending, setPanelPending] = useState<PanelToggleTarget | null>(null);
  const [panelError, setPanelError] = useState('');
  // 「单行消耗」「实时路由」不画额度：不去读可能要几十秒的额度来源。换到别的板式时重新读一次。
  const needsQuota = !(layout === 'compact' || layout === 'routing');
  // 「实时路由」与「托盘面板」才轮询网关（挂件唯一能读的网关命令，已脱敏）。
  const routing = useRoutingLive({ enabled: configReady && (layout === 'routing' || layout === 'panel'), readFeed: readRoutingFeed, readExternal: readExternalFeed });
  const needsQuotaRef = useRef(needsQuota);
  needsQuotaRef.current = needsQuota;

  const load = useCallback(async (nextRange: WidgetRange) => {
    const current = ++generation.current;
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      // 整次读取失败（invoke 被拒绝）与「成功读到但没有来源」分开携带，不在这里就地吞成 []
      // （P2-1，T10.192 修复轮）：吞成 [] 会让 readWidgetQuota 之后无法分辨这两种情况。
      const quotaRequest = needsQuotaRef.current
        ? invoke<unknown>('get_local_quota_providers')
          .then((response) => ({ failed: false as const, response }))
          .catch(() => ({ failed: true as const, response: null as unknown }))
        : null;
      const statsResponse = await invoke<unknown>('get_cached_stats', {
        scope: 'local',
        range: nextRange,
        deviceFilter: 'all_cloud',
        timezone,
        machines: [],
        tools: [],
        models: [],
        search: null,
        tokenMode: 'effective',
      });
      if (current !== generation.current) return;
      const stats = parseStatsDataContract(statsResponse);
      const loadedAt = new Date();
      lastLoadedAt.current = loadedAt.getTime();
      setSnapshot({ stats, range: nextRange, quota: null, loadedAt });
      // 额度来源可能耗时数十秒，不能挡住本机缓存统计的首屏。
      void quotaRequest?.then((result) => {
        if (current !== generation.current) return;
        const quota = result.failed ? failedWidgetQuota() : readWidgetQuota(result.response);
        setSnapshot((value) => value && ({ ...value, quota }));
      });
      setErrors((value) => ({ ...value, [nextRange]: '' }));
    } catch {
      if (current !== generation.current) return;
      setErrors((value) => ({ ...value, [nextRange]: '读取失败' }));
    }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      setConfig(widgetConfigFromSettings(await invoke<AppSettings>('get_settings'), mode));
    } catch {
      // 读不到设置就用默认板式：挂件可以显示得不合心意，但不能因此空白。
    } finally {
      setConfigReady(true);
    }
  }, [mode]);

  useEffect(() => {
    document.documentElement.setAttribute('data-view', 'widget');
    document.body.className = mode === 'desktop' ? 'widget-window widget-desktop' : 'widget-window';
    return () => {
      document.documentElement.removeAttribute('data-view');
    };
  }, [mode]);

  useEffect(() => {
    void loadConfig();
    let disposed = false;
    let dispose: (() => void) | undefined;
    void listen('settings-updated', () => void loadConfig())
      .then((unlisten) => {
        if (disposed) unlisten();
        else dispose = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      dispose?.();
    };
  }, [loadConfig]);

  useEffect(() => {
    const root = document.documentElement;
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;
    const apply = () => {
      const next = resolveWidgetTheme(config.theme, media?.matches ?? false);
      root.setAttribute('data-theme', next);
      root.style.colorScheme = next;
      setTheme(next);
    };
    apply();
    // `useTheme` 的全局监听会在系统深浅色变化或主窗口改主题时改写同一个属性；
    // 挂件有自己的主题设置，必须在同一批事件里改回来。这里的监听注册得比
    // `initializeTheme()` 晚，因此总是后执行。
    media?.addEventListener?.('change', apply);
    window.addEventListener('storage', apply);
    return () => {
      media?.removeEventListener?.('change', apply);
      window.removeEventListener('storage', apply);
    };
  }, [config.theme]);

  useEffect(() => {
    // 等设置到位再读统计：否则默认范围不是「今日」时会先闪一屏今日数字再整块清空。
    if (!configReady) return;
    void load(range);
  }, [configReady, load, range, needsQuota]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    for (const event of ['stats-updated', 'prices-updated']) {
      void listen(event, () => void load(rangeRef.current)).then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      }).catch(() => undefined);
    }
    const reconcile = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastLoadedAt.current < VISIBLE_RECONCILE_MS) return;
      void load(rangeRef.current);
    };
    const timer = window.setInterval(reconcile, 60_000);
    document.addEventListener('visibilitychange', reconcile);
    const clock = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      disposed = true;
      generation.current += 1;
      unlisteners.forEach((unlisten) => unlisten());
      window.clearInterval(timer);
      window.clearInterval(clock);
      document.removeEventListener('visibilitychange', reconcile);
    };
  }, [load]);

  const loadPanelStatus = useCallback(async () => {
    try {
      setPanelStatus(await invoke<TrayPanelStatus>('tray_panel_status'));
    } catch {
      // 读不到就保持上一份；开关按钮在拿到第一份状态前不可点。
    }
  }, []);

  useEffect(() => {
    if (!configReady || layout !== 'panel') return undefined;
    void loadPanelStatus();
    let disposed = false;
    let dispose: (() => void) | undefined;
    void listen('settings-updated', () => void loadPanelStatus())
      .then((unlisten) => {
        if (disposed) unlisten();
        else dispose = unlisten;
      })
      .catch(() => undefined);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadPanelStatus();
    }, PANEL_STATUS_POLL_MS);
    return () => {
      disposed = true;
      dispose?.();
      window.clearInterval(timer);
    };
  }, [configReady, layout, loadPanelStatus]);

  const togglePanel = async (target: PanelToggleTarget, enabled: boolean) => {
    if (panelPending) return;
    setPanelPending(target);
    setPanelError('');
    try {
      setPanelStatus(await invoke<TrayPanelStatus>('tray_panel_toggle', { target, enabled }));
    } catch {
      setPanelError('切换失败，请到主窗口重试');
    } finally {
      setPanelPending(null);
    }
  };

  const changeRange = (next: WidgetRange) => {
    if (next === range) return;
    setRangeOverride(next);
  };

  const refresh = async () => {
    if (busy) return;
    const requestedRange = rangeRef.current;
    const current = generation.current;
    setBusy(true);
    try {
      await invoke('refresh_scan');
      await load(rangeRef.current);
    } catch {
      // 迟到的扫描失败不能盖过新范围或后来成功读取的状态。
      if (current === generation.current && requestedRange === rangeRef.current) {
        setErrors((value) => ({ ...value, [requestedRange]: '扫描失败' }));
      }
    } finally {
      setBusy(false);
    }
  };

  const openMain = () => {
    void invoke('focus_main_window').catch(() => undefined);
  };

  const hide = () => {
    void invoke('hide_widget_window').catch(() => undefined);
  };

  /** 托盘弹层：指针进出上报给原生侧，悬停期间离开托盘图标也不会自动收起。 */
  const reportHover = (inside: boolean) => {
    if (mode !== 'popover') return;
    void invoke('widget_pointer_hover', { inside }).catch(() => undefined);
  };

  const openSettings = () => {
    void invoke('open_main_settings').catch(() => undefined);
  };

  // 托盘面板关网关：去主窗口「模型接入」，那里会先检查仍指向网关的 Agent 并提供恢复。
  const openModelAccess = () => {
    void invoke('open_main_settings', { anchor: 'settings-model-access' }).catch(() => undefined);
  };

  const removeFromDesktop = () => {
    void invoke('set_desktop_widget_enabled', { enabled: false }).catch(() => undefined);
  };

  const currentSnapshot = snapshot?.range === range ? snapshot : null;
  const model = useMemo(() => buildCardModel({
    range,
    stats: currentSnapshot?.stats ?? null,
    loadedAt: currentSnapshot?.loadedAt ?? null,
    error: errors[range] ?? '',
    quota: buildCardQuota(currentSnapshot?.quota ?? null, config.providerId),
    theme,
  }), [range, currentSnapshot, errors, config.providerId, theme]);

  const actions: WidgetActions = {
    refresh: () => void refresh(),
    openMain,
    openSettings,
    close: mode === 'desktop' ? removeFromDesktop : hide,
  };
  // 「额度总览」只看额度，范围分段对它没有意义，藏起来而不是留一组点了没反应的按钮。
  const showsRange = !(layout === 'quota' || layout === 'routing' || layout === 'panel');
  // 工具条盖在“更新于”上：「额度与用量」的“更新于”在右栏底部，其余板式在右上角。
  const toolbarAt = layout === 'combo' ? 'bottom' : 'top';

  return (
    <div
      className="widget-root"
      data-range={range}
      data-mode={mode}
      data-layout={layout}
      data-card-theme={theme}
      data-toolbar={mode === 'desktop' ? (hovered ? 'shown' : 'hidden') : undefined}
      // 桌面小组件除工具条外整张卡都是拖动区（方案 §6.6）：`deep` 让子元素也能拖，按钮自己挡住拖动。
      // 托盘弹层每次显示都会贴回托盘锚点，指针离开还会自动收起，可拖动只是个不成立的暗示（T10.128 P2）。
      data-tauri-drag-region={mode === 'desktop' ? 'deep' : undefined}
      onMouseEnter={() => {
        reportHover(true);
        if (mode === 'desktop') setHovered(true);
      }}
      onMouseLeave={() => {
        reportHover(false);
        setHovered(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && mode === 'popover') hide();
      }}
    >
      {mode === 'popover' && (
        <TrayTopBar range={range} showRange={showsRange} onRange={changeRange} actions={actions} busy={busy} />
      )}
      {layout === 'panel' ? (
        <PanelCard
          model={model}
          now={now}
          scene={routing.scene}
          loaded={routing.loaded}
          controls={{
            status: panelStatus,
            pending: panelPending,
            error: panelError,
            onToggle: (target, enabled) => void togglePanel(target, enabled),
            onCloseGateway: openModelAccess,
          }}
          noticeActions={mode === 'popover' ? { openSettings, openMain } : null}
          toolbar={mode === 'desktop' ? <DesktopToolbar shown={hovered} at="top" actions={actions} busy={busy} /> : null}
        />
      ) : layout === 'routing' ? (
        <RoutingCard
          scene={routing.scene}
          loaded={routing.loaded}
          toolbar={mode === 'desktop' ? <DesktopToolbar shown={hovered} at={toolbarAt} actions={actions} busy={busy} /> : null}
        />
      ) : (
        <LedgerCard
          layout={layout}
          model={model}
          now={now}
          noticeActions={mode === 'popover' ? { openSettings, openMain } : null}
          toolbar={mode === 'desktop' ? <DesktopToolbar shown={hovered} at={toolbarAt} actions={actions} busy={busy} /> : null}
        />
      )}
    </div>
  );
}

export default WidgetView;
