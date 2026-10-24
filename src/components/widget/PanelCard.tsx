import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { CloudUpload, Power, ScanLine } from 'lucide-react';
import { RoutingStage, RoutingStageEmpty } from '../../features/gateway/RoutingStage';
import type { RoutingScene, SceneFlow } from '../../features/gateway/routingScene';
import { describeQuotaItem, quotaStateTail, type CardModel, type CardQuotaItem } from './cardModel';
import { ChangeChip, QuotaNotice, Status, type QuotaNoticeActions } from './LedgerCard';

/**
 * 「托盘面板」板式 364×560（菜单栏 / 托盘增强）。从上到下：
 * - 今日：预估费用大数字 + 有效 Token、记录数与较昨日同期；
 * - 额度：每个窗口一条横条，写「可用 N%」与重置倒计时（与 Android「额度条」小组件同一口径）；
 * - 网关：运行状态 + 紧凑路由舞台（与路由页、「实时路由」板式同一个组件）+ 最近三条路由；
 * - 快捷开关：网关（模型接入）、后台同步、后台扫描。
 * 数据都由 `WidgetView` 读好传进来：挂件窗口能调哪些命令只看 `WidgetView` 里字面写出的 invoke。
 */

/** 面板里最多画几条额度横条；再多写「另有 N 条」。 */
export const PANEL_QUOTA_LIMIT = 4;
/** 最近路由最多列几条。 */
export const PANEL_RECENT_LIMIT = 3;

export type PanelToggleTarget = 'gateway' | 'sync' | 'scan';

/** `tray_panel_status` / `tray_panel_toggle` 的返回（Rust `TrayPanelStatus`）。 */
export interface TrayPanelStatus {
  gatewayEnabled: boolean;
  gatewayRunning: boolean;
  gatewayPort: number;
  gatewayFailed: boolean;
  /** 网关开着但没有启用的供应商：不会启动。 */
  gatewayNoProvider: boolean;
  syncPaused: boolean;
  scanPaused: boolean;
  scanIntervalSecs: number;
}

export interface PanelControls {
  /** null = 还在读，或设置页预览。 */
  status: TrayPanelStatus | null;
  /** 正在切换的那一项：按钮转圈、禁用，避免连点。 */
  pending: PanelToggleTarget | null;
  error: string;
  onToggle: (target: PanelToggleTarget, enabled: boolean) => void;
  /** 网关开着时点它：去主窗口「模型接入」关（那里会先检查仍指向网关的 Agent）。 */
  onCloseGateway: () => void;
}

export function gatewayState(status: TrayPanelStatus | null): { text: string; tone: 'ok' | 'off' | 'warn' | 'unknown' } {
  if (!status) return { text: '—', tone: 'unknown' };
  if (!status.gatewayEnabled) return { text: '已关闭', tone: 'off' };
  if (status.gatewayRunning) return { text: `运行中 · :${status.gatewayPort}`, tone: 'ok' };
  if (status.gatewayFailed) return { text: '未运行，去主窗口查看', tone: 'warn' };
  if (status.gatewayNoProvider) return { text: '没有可用的供应商，去主窗口添加', tone: 'warn' };
  return { text: '正在启动…', tone: 'warn' };
}

function formatAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.round(minutes / 60)} 小时前`;
}

/** 一条最近路由的短句：「claude → anthropic」，切换过写「relay ✕ → anthropic」。 */
export function describeRecentRoute(flow: SceneFlow): { path: string; outcome: 'ok' | 'failed' | 'pending' } {
  const hops = flow.hops.map((hop, index) => (
    index < flow.hops.length - 1 || hop.outcome === 'failed' || hop.outcome === 'rejected' ? `${hop.target} ✕` : hop.target
  ));
  const path = hops.length > 0 ? `${flow.agent} → ${hops.join(' → ')}` : `${flow.agent} → 选路中`;
  const outcome = flow.phase === 'failed' ? 'failed' : flow.phase === 'inflight' ? 'pending' : 'ok';
  return { path, outcome };
}

function QuotaBar({ item, now }: { item: CardQuotaItem; now: number }) {
  const tail = quotaStateTail(item, now);
  const name = `${item.provider}${item.group ? ` · ${item.group}` : ''} ${item.label}`;
  return (
    <li className="wl-qbar" data-level={item.level} data-stale={item.stale ? 'true' : undefined} aria-label={describeQuotaItem(item, now)}>
      <div className="wl-qbar-head" aria-hidden="true">
        <span className="wl-qbar-name">{name}</span>
        {tail && <span className="wl-qbar-tail">{tail}</span>}
        <span className="wl-qbar-value">可用 {item.available}%</span>
      </div>
      <div className="wl-qbar-track" aria-hidden="true">
        <i style={{ width: `${Math.max(0, Math.min(100, item.available))}%` }} />
      </div>
    </li>
  );
}

/** 按钮上写短名，读屏与悬停提示用全名。 */
const TOGGLES: ReadonlyArray<{ id: PanelToggleTarget; label: string; name: string; icon: LucideIcon; hint: string }> = [
  { id: 'gateway', label: '网关', name: '网关', icon: Power, hint: '模型接入总开关：在这里可以打开；关闭要到主窗口，先检查仍指向网关的 Agent' },
  { id: 'sync', label: '同步', name: '后台同步', icon: CloudUpload, hint: '后台同步：扫描后自动同步到云端（手动同步不受影响）' },
  { id: 'scan', label: '扫描', name: '后台扫描', icon: ScanLine, hint: '后台扫描：定时扫描本机日志（顶栏刷新按钮照常可用）' },
];

function toggleOn(status: TrayPanelStatus, id: PanelToggleTarget): boolean {
  if (id === 'gateway') return status.gatewayEnabled;
  if (id === 'sync') return !status.syncPaused;
  return !status.scanPaused;
}

function Toggles({ controls, staticPreview }: { controls: PanelControls | null; staticPreview: boolean }) {
  const status = controls?.status ?? null;
  return (
    <div className="wl-toggles" role="group" aria-label="快捷开关">
      {TOGGLES.map((toggle) => {
        const on = status ? toggleOn(status, toggle.id) : toggle.id !== 'gateway';
        const glyph = <toggle.icon size={15} strokeWidth={2} aria-hidden="true" />;
        const body = (
          <>
            {glyph}
            <span className="wl-toggle-label">{toggle.label}</span>
            <span className="wl-toggle-state" aria-hidden="true">{on ? '开' : '关'}</span>
          </>
        );
        if (staticPreview || !controls || !status) {
          return <span key={toggle.id} className="wl-toggle" data-on={on ? 'true' : undefined} title={toggle.hint}>{body}</span>;
        }
        const pending = controls.pending === toggle.id;
        return (
          <button
            key={toggle.id}
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={toggle.name}
            className="wl-toggle"
            data-on={on ? 'true' : undefined}
            data-pending={pending ? 'true' : undefined}
            disabled={controls.pending !== null}
            title={toggle.hint}
            onClick={() => (toggle.id === 'gateway' && on ? controls.onCloseGateway() : controls.onToggle(toggle.id, !on))}
          >
            {body}
          </button>
        );
      })}
    </div>
  );
}

export function PanelCard({ model, now, scene, loaded, controls, noticeActions, toolbar, staticPreview = false }: {
  model: CardModel;
  now: number;
  /** null = 设置页预览：不读网关，只画示意。 */
  scene: RoutingScene | null;
  loaded: boolean;
  controls: PanelControls | null;
  noticeActions?: QuotaNoticeActions | null;
  /** 桌面小组件的悬停工具条（盖在「更新于」上）。 */
  toolbar?: ReactNode;
  staticPreview?: boolean;
}) {
  const quota = model.quota;
  const items = quota.kind === 'ready' ? quota.items.slice(0, PANEL_QUOTA_LIMIT) : [];
  const hidden = quota.kind === 'ready' ? quota.items.length - items.length : 0;
  const gateway = gatewayState(controls?.status ?? null);
  const recent = scene && !scene.empty ? scene.flows.slice(0, PANEL_RECENT_LIMIT) : [];
  return (
    <div className="wl-card" data-layout="panel">
      <section className="wl-panel-usage" aria-label="今日用量">
        <div className="wl-row wl-title">
          <span className="wl-cap">今日</span>
          <Status status={model.status} className="wl-under-toolbar" />
        </div>
        {toolbar}
        <div className="wl-panel-hero">
          <div className="wl-panel-hero-main">
            <span className="wl-num wl-panel-cost">{model.cost}</span>
            <span className="wl-meta">预估费用</span>
          </div>
          <div className="wl-panel-hero-side">
            <span className="wl-panel-tokens"><b>{model.tokens}</b> 有效 Token</span>
            <span className="wl-meta">{model.records} 条记录</span>
            <ChangeChip change={model.change} short />
          </div>
        </div>
      </section>
      <hr className="wl-hr" />
      <section className="wl-panel-quota" aria-label="订阅额度">
        <div className="wl-row wl-title">
          <span className="wl-cap">额度</span>
          <span className="wl-meta">
            {quota.kind !== 'ready' ? '' : hidden > 0 ? `最紧 ${items.length} 个 · 另有 ${hidden} 个在主窗口` : `${quota.items.length} 个窗口 · 按可用排序`}
          </span>
        </div>
        {quota.kind === 'ready' ? (
          <ul className="wl-qbars">
            {items.map((item) => <QuotaBar key={item.key} item={item} now={now} />)}
          </ul>
        ) : (
          <QuotaNotice quota={quota} actions={noticeActions} ringSize={44} />
        )}
      </section>
      <hr className="wl-hr" />
      <section className="wl-panel-gateway" aria-label="网关与最近路由">
        <div className="wl-row wl-title">
          <span className="wl-cap">网关</span>
          <span className="wl-gw-state" data-tone={gateway.tone}><i aria-hidden="true" />{gateway.text}</span>
        </div>
        <div className="wl-panel-stage">
          {!scene ? (
            <div className="rs-empty is-compact" role="note">
              <b>Agent → 网关 → 上游</b>
              <span>网关有请求时在这里实时流动，失败切换可见。</span>
            </div>
          ) : !loaded ? null : scene.empty ? (
            <RoutingStageEmpty scene={scene} variant="compact" />
          ) : (
            <RoutingStage scene={scene} variant="compact" title="最近路由动画" />
          )}
        </div>
        {recent.length > 0 && (
          <ol className="wl-recent" aria-label="最近路由">
            {recent.map((flow) => {
              const route = describeRecentRoute(flow);
              return (
                <li key={flow.id} data-outcome={route.outcome}>
                  <i aria-hidden="true" />
                  <span className="wl-recent-path">{route.path}</span>
                  <span className="wl-meta">{route.outcome === 'pending' ? '进行中' : formatAgo(flow.at, Date.now())}</span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
      <Toggles controls={controls} staticPreview={staticPreview} />
      {controls?.error && <span className="wl-meta is-error wl-panel-error" role="alert">{controls.error}</span>}
    </div>
  );
}
