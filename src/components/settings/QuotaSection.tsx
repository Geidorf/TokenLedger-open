import { invoke } from '@tauri-apps/api/core';
import { type FormEvent, type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Cloud, FileDiff, FlaskConical, Gauge, Info, KeyRound, LoaderCircle, Plus, RefreshCw, Trash2, Wallet } from 'lucide-react';
import type {
  AppSettings,
  BusyState,
  CloudStatus,
  CustomQuotaEndpointView,
  QuotaBalanceSourceView,
  QuotaBalanceVendor,
  QuotaExperimentalPlanView,
  QuotaProviderEnvelope,
  QuotaRelayBalanceConfig,
  QuotaSourceDetection,
  QuotaSyncStatus,
} from '../../types';
import { formatQuotaCurrencyAmount, quotaWindowDisplayLabel } from '../QuotaPanel';
import { quotaLevel, readQuotaWindow } from '../../utils/quotaOverview';
import {
  DangerZone,
  DisclosurePanel,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsToggleRow,
  useFirstEnableSignal,
} from './SettingsPrimitives';
import type { RequestConfirmation } from '../../utils/confirmation';
import { focusWrapTarget, quotaClearFeedback, quotaSyncCapacityMessage } from '../../utils/frontendContracts';
import { QUOTA_ALERT_THRESHOLDS, toggleQuotaAlertThreshold, useQuotaAlertSettings } from '../../hooks/useQuota';

export interface QuotaSectionProps {
  appSettings: AppSettings;
  cloudStatus: CloudStatus;
  quotaProviders: QuotaProviderEnvelope[];
  quotaSyncStatus: QuotaSyncStatus;
  busy: BusyState;
  onSettingChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onClaudeNativeQuotaChange: (enabled: boolean) => void;
  onAntigravityLocalQuotaChange: (enabled: boolean) => void;
  onAuthorizeClaudeNativeQuota: () => void;
  onAuthorizeAntigravityQuota: () => void;
  onQuotaSyncToggle: (enabled: boolean) => void;
  onQuotaSyncNow: () => void;
  onDeleteQuotaProvider: (providerId: string, scope: string) => Promise<boolean> | void;
  onClearQuotaSnapshots: () => Promise<boolean> | void;
  onConfirm: RequestConfirmation;
  onCustomQuotaChanged: () => void;
}

type CustomEndpointAction = { kind: 'toggle' | 'delete'; id: string } | null;
type QuotaSnapshotAction = { kind: 'provider'; providerId: string } | { kind: 'all' } | null;

export interface OrphanedCustomQuotaProvider {
  providerId: string;
  displayName: string;
}

export interface QuotaOverviewSummary {
  localEnabledCount: number;
  localConnectedCount: number;
  localAttentionCount: number;
  companyConfiguredCount: number;
  companyEnabledCount: number;
  syncLabel: string;
}

export function quotaOverviewSummary(
  appSettings: Pick<
    AppSettings,
    | 'quota_codex_local_enabled'
    | 'quota_claude_enabled'
    | 'quota_antigravity_local_enabled'
  >,
  endpoints: CustomQuotaEndpointView[],
  syncLabel: string,
  localStates: readonly QuotaSourceCardState[] = [],
): QuotaOverviewSummary {
  return {
    localEnabledCount: [
      appSettings.quota_codex_local_enabled,
      appSettings.quota_claude_enabled,
      appSettings.quota_antigravity_local_enabled,
    ].filter(Boolean).length,
    localConnectedCount: localStates.filter((state) => state === 'connected').length,
    localAttentionCount: localStates.filter((state) => state === 'login-required' || state === 'read-failed').length,
    companyConfiguredCount: endpoints.length,
    companyEnabledCount: endpoints.filter((endpoint) => endpoint.enabled).length,
    syncLabel,
  };
}

/** 设置页每个本机来源一张状态卡，状态只有这五种（REQ-QUOTA-09）。 */
export type QuotaSourceCardState = 'not-installed' | 'needs-authorization' | 'connected' | 'login-required' | 'read-failed';

export type QuotaSourceAction = 'install' | 'read';

export interface QuotaSourceWindowView {
  windowId: string;
  label: string;
  remaining: number;
  resetLabel: string | null;
}

export interface QuotaSourceCardView {
  state: QuotaSourceCardState;
  label: string;
  sentence: string;
  action: QuotaSourceAction | null;
  /** ⓘ 悬停时显示的原因原文。 */
  detail?: string;
  windows: QuotaSourceWindowView[];
  /** 读取失败但保留旧值时，旧值的观测时间。 */
  asOf?: string;
}

export interface QuotaSourceCardInput {
  name: string;
  enabled: boolean;
  /** null 表示检测结果未知（检测失败或尚未返回），不据此置灰。 */
  installed: boolean | null;
  provider: QuotaProviderEnvelope | undefined;
  now: number;
}

interface ReasonCopy {
  sentence: string;
  action: QuotaSourceAction | null;
  detail: string;
}

const LOGIN_REASON_CODES = new Set([
  'app_server_auth_required',
  'claude_native_authorization_required',
  'antigravity_native_authorization_required',
]);

const SOURCE_REASON_COPY: Record<string, ReasonCopy> = {
  app_server_auth_required: { sentence: '请在 Codex 中登录 ChatGPT 账户后回来刷新。', action: null, detail: 'Codex 当前未完成 ChatGPT 登录，或账户没有可读取的额度窗口。' },
  app_server_unavailable: { sentence: 'Codex 官方本地接口暂不可用，可升级 Codex 后重试。', action: null, detail: 'Codex app-server 不可用，受限回退也没有可信值。' },
  app_server_timeout: { sentence: 'Codex 响应超时，稍后会自动重试。', action: null, detail: 'Codex app-server 在限定时间内没有返回。' },
  claude_statusline_snapshot_missing: { sentence: '还没收到 Claude Code 的额度数据，新开一个会话跑一轮即可。', action: null, detail: '尚未收到含 rate_limits 的 status line 输入；首次 API 响应后才会出现额度字段。' },
  claude_statusline_snapshot_invalid: { sentence: 'Claude Code 交来的额度数据无效，请重新一键接入。', action: null, detail: 'status line 快照越界、损坏、过期或身份检查失败。' },
  claude_native_authorization_required: { sentence: '请在 Claude Desktop 或 Claude Code 中重新登录。', action: 'read', detail: '本机 Claude 代理返回登录失效。' },
  claude_native_cli_unavailable: { sentence: '没有找到可用的 Claude CLI。', action: 'install', detail: '内置 /usage 未发现 Claude Desktop 随附代理或本机 Claude Code。' },
  claude_native_timeout: { sentence: 'Claude /usage 读取超时。', action: 'read', detail: '内置 /usage PTY 在限定时间内没有返回。' },
  claude_native_usage_unavailable: { sentence: 'Claude CLI 的 /usage 暂时打不开。', action: 'read', detail: 'Claude CLI 的 /usage 通道加载失败；Claude Desktop 网页额度可能同时正常。' },
  claude_native_subscription_unavailable: { sentence: '当前 Claude 订阅没有提供可量化的额度窗口。', action: null, detail: '/usage 只返回订阅提示，没有 5 小时或每周数值。' },
  claude_native_response_invalid: { sentence: 'Claude /usage 没有返回可验证的额度。', action: 'read', detail: '输出超限、百分比或重置时间越界，或没有合法窗口。' },
  claude_codexbar_unavailable: { sentence: '实验来源没有读到 Claude 额度。', action: 'read', detail: '未找到 CodexBar CLI，内置 /usage 也未成功。' },
  claude_codexbar_timeout: { sentence: 'CodexBar 读取超时。', action: 'read', detail: 'CodexBar Claude 额度读取超时。' },
  claude_codexbar_response_invalid: { sentence: 'CodexBar 没有返回可验证的 Claude 额度。', action: 'read', detail: '请在 CodexBar 中确认 Claude 来源已授权。' },
  antigravity_native_authorization_required: { sentence: '请在 Antigravity 中完成登录。', action: 'read', detail: 'Antigravity 本地服务拒绝访问或登录不可用。' },
  antigravity_native_source_not_found: { sentence: '请先打开 Antigravity，再立即读取。', action: 'read', detail: '未发现正在运行的 Antigravity App、IDE 或 agy 本地服务。' },
  antigravity_native_port_unavailable: { sentence: '请先打开 Antigravity，再立即读取。', action: 'read', detail: '未发现 Antigravity 本地额度服务端口。' },
  antigravity_native_timeout: { sentence: 'Antigravity 读取超时。', action: 'read', detail: 'Antigravity 本地服务在限定时间内没有返回。' },
  antigravity_native_response_invalid: { sentence: 'Antigravity 没有返回可验证的额度。', action: 'read', detail: '本地服务响应越界或没有合法额度窗口。' },
  antigravity_codexbar_unavailable: { sentence: 'Antigravity 内置读取失败，也没有可用的 CodexBar。', action: 'read', detail: '内置读取失败，且未找到可用的 CodexBar CLI 兜底。' },
  antigravity_codexbar_timeout: { sentence: 'CodexBar 读取超时。', action: 'read', detail: 'CodexBar 的 Antigravity 额度读取超时。' },
  antigravity_codexbar_response_invalid: { sentence: 'CodexBar 没有返回可验证的额度。', action: 'read', detail: 'CodexBar 未返回可验证的 Antigravity 本地额度。' },
  permission_denied: { sentence: '本机来源没有读取权限。', action: null, detail: '允许范围内的本地来源不可读。' },
  source_not_found: { sentence: '没有找到可读取的本机来源。', action: null, detail: '允许范围内未找到本地来源。' },
  observation_stale: { sentence: '来源暂未刷新，下面是上次的值。', action: 'read', detail: '当前只有历史快照，或窗口已过新鲜期。' },
  reset_elapsed: { sentence: '额度窗口已到重置时间，等待来源刷新。', action: 'read', detail: '来源仍新鲜，但该窗口的重置时间已过。' },
};

const GENERIC_READ_FAILURE: ReasonCopy = { sentence: '这次没有读到额度。', action: 'read', detail: '' };

function formatSourceRelative(observedAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - observedAt) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1_440)} 天前`;
}

function formatSourceReset(resetsAt: string | undefined, now: number): string | null {
  if (!resetsAt) return null;
  const at = new Date(resetsAt).getTime();
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return '正在重置';
  if (minutes < 120) return `${minutes} 分钟后重置`;
  if (minutes < 2_880) return `${Math.round(minutes / 60)} 小时后重置`;
  return `${Math.round(minutes / 1_440)} 天后重置`;
}

export function formatSourceAsOf(observedAt: string): string {
  const date = new Date(observedAt);
  if (Number.isNaN(date.getTime())) return observedAt;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function latestObservedAt(provider: QuotaProviderEnvelope | undefined): string | undefined {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const window of provider?.windows ?? []) {
    const at = new Date(window.observedAt).getTime();
    if (Number.isFinite(at) && at > latestMs) {
      latestMs = at;
      latest = window.observedAt;
    }
  }
  return latest;
}

function sourceWindows(provider: QuotaProviderEnvelope | undefined, now: number): QuotaSourceWindowView[] {
  if (!provider || (provider.status !== 'ok' && provider.status !== 'stale')) return [];
  return provider.windows.flatMap((window) => {
    const reading = readQuotaWindow(window, now);
    if (!reading) return [];
    return [{
      windowId: window.windowId,
      label: quotaWindowDisplayLabel(window),
      remaining: reading.remaining,
      resetLabel: formatSourceReset(reading.resetsAt, now),
    }];
  });
}

/**
 * 状态只由开关、本机检测和既有 envelope 的 status/reasonCode/windows 推导，
 * 不新增 wire 字段（DESIGN §5.6）。
 */
export function quotaSourceCardView({ name, enabled, installed, provider, now }: QuotaSourceCardInput): QuotaSourceCardView {
  if (!enabled) {
    if (installed === false) {
      return { state: 'not-installed', label: '未安装', sentence: `这台电脑上没有检测到 ${name}。`, action: 'install', windows: [] };
    }
    return { state: 'needs-authorization', label: '待授权', sentence: '打开开关后才会读取。', action: null, windows: [] };
  }
  if (!provider) {
    return { state: 'needs-authorization', label: '待授权', sentence: '正在等待首次读取。', action: null, windows: [] };
  }
  const windows = sourceWindows(provider, now);
  const observedAt = latestObservedAt(provider);
  const reasonCode = provider.reasonCode;
  const copy = (reasonCode && SOURCE_REASON_COPY[reasonCode]) || GENERIC_READ_FAILURE;
  const detail = reasonCode ? `${copy.detail || copy.sentence}（${reasonCode}）` : undefined;
  if (provider.status === 'ok') {
    const observedMs = observedAt ? new Date(observedAt).getTime() : Number.NaN;
    return {
      state: 'connected',
      label: Number.isFinite(observedMs) ? `已连接 · ${formatSourceRelative(observedMs, now)}` : '已连接',
      sentence: windows.length > 0 ? '额度来自本机官方客户端。' : '已连接，来源暂未返回可展示的窗口。',
      action: 'read',
      windows,
    };
  }
  if ((reasonCode && LOGIN_REASON_CODES.has(reasonCode))
    || (provider.status === 'auth-required' && !reasonCode?.endsWith('_local_authorization_required'))) {
    return {
      state: 'login-required',
      label: '需在原应用登录',
      sentence: copy.sentence,
      action: copy.action,
      detail,
      windows,
      asOf: windows.length > 0 ? observedAt : undefined,
    };
  }
  if (provider.status === 'auth-required') {
    return { state: 'needs-authorization', label: '待授权', sentence: '授权尚未生效，稍后自动刷新。', action: null, detail, windows: [] };
  }
  if (installed === false && windows.length === 0) {
    return { state: 'not-installed', label: '未安装', sentence: `这台电脑上没有检测到 ${name}。`, action: 'install', detail, windows: [] };
  }
  if (reasonCode === 'claude_statusline_snapshot_missing' && windows.length === 0) {
    return { state: 'needs-authorization', label: '待授权', sentence: copy.sentence, action: null, detail, windows: [] };
  }
  return {
    state: 'read-failed',
    label: windows.length > 0 ? '读取失败（保留旧值）' : '读取失败',
    sentence: copy.sentence,
    action: copy.action,
    detail,
    windows,
    asOf: windows.length > 0 ? observedAt : undefined,
  };
}

export function parseQuotaSourceDetections(value: unknown): Map<string, QuotaSourceDetection> {
  const detections = new Map<string, QuotaSourceDetection>();
  if (!Array.isArray(value)) return detections;
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { providerId, installed, candidatePaths } = item as Record<string, unknown>;
    if (typeof providerId !== 'string' || typeof installed !== 'boolean') continue;
    detections.set(providerId, {
      providerId,
      installed,
      candidatePaths: Array.isArray(candidatePaths) ? candidatePaths.filter((path): path is string => typeof path === 'string') : [],
    });
  }
  return detections;
}

const QUOTA_SOURCE_INSTALL_URLS: Record<string, string> = {
  'openai-codex-local': 'https://developers.openai.com/codex/cli',
  'anthropic-claude-consumer': 'https://docs.anthropic.com/en/docs/claude-code/setup',
  'google-antigravity-consumer': 'https://antigravity.google/download',
};

const SOURCE_STATE_TONES: Record<QuotaSourceCardState, 'pending' | 'waiting' | 'ready' | 'blocked'> = {
  'not-installed': 'pending',
  'needs-authorization': 'waiting',
  connected: 'ready',
  'login-required': 'waiting',
  'read-failed': 'blocked',
};

function QuotaSourceStatus({ providerId, name, view, readLabel, readBusyLabel, readBusy, readDisabled, onRead }: {
  providerId: string;
  name: string;
  view: QuotaSourceCardView;
  readLabel: string;
  readBusyLabel: string;
  readBusy: boolean;
  readDisabled: boolean;
  /** 来源不支持手动读取时不传，卡上就不出现读取按钮。 */
  onRead?: () => void;
}) {
  const installUrl = QUOTA_SOURCE_INSTALL_URLS[providerId];
  return (
    <div className="quota-source-status" data-state={view.state}>
      <div className="quota-source-status-head">
        <span className={`settings-value quota-setup-stage quota-setup-stage-${SOURCE_STATE_TONES[view.state]}`} role="status">
          {view.label}
        </span>
        {view.asOf && <span className="quota-source-asof">截至 {formatSourceAsOf(view.asOf)}</span>}
      </div>
      <div className="quota-source-message">
        <p>
          {view.sentence}
          {view.detail && (
            <span className="quota-source-info" role="note" tabIndex={0} title={view.detail} aria-label={`${name} 详细原因：${view.detail}`}>
              <Info className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          )}
        </p>
        {view.action === 'install' && installUrl && (
          <a className="secondary-inline" href={installUrl} target="_blank" rel="noopener noreferrer" aria-label={`${name} 官方安装说明`}>
            安装说明
          </a>
        )}
        {view.action === 'read' && onRead && (
          <button
            className="secondary-inline"
            type="button"
            disabled={readDisabled}
            aria-label={readBusy ? readBusyLabel : readLabel}
            aria-busy={readBusy || undefined}
            title={readBusy ? readBusyLabel : readLabel}
            onClick={onRead}
          >
            {readBusy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
            {readBusy ? '读取中…' : '立即读取'}
          </button>
        )}
      </div>
      {view.windows.length > 0 && (
        <ul className="quota-source-windows" aria-label={`${name} 额度窗口`}>
          {view.windows.map((window) => (
            <li key={window.windowId} className="quota-source-window">
              <div className="quota-source-window-head">
                <span>{window.label}</span>
                <b>剩余 {window.remaining}%</b>
              </div>
              <div
                className="quota-source-meter"
                data-level={quotaLevel(window.remaining)}
                role="progressbar"
                aria-label={`${name} ${window.label} 剩余额度`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={window.remaining}
              >
                <span style={{ width: `${window.remaining}%` }} />
              </div>
              {window.resetLabel && <small>{window.resetLabel}</small>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function orphanedCustomQuotaProviders(
  endpoints: CustomQuotaEndpointView[],
  providers: QuotaProviderEnvelope[],
): OrphanedCustomQuotaProvider[] {
  const configured = new Set(endpoints.map((endpoint) => endpoint.providerId));
  const seen = new Set<string>();
  return providers.flatMap((provider) => {
    if (
      !provider.providerId.startsWith('company-openapi-')
      || configured.has(provider.providerId)
      || seen.has(provider.providerId)
    ) {
      return [];
    }
    seen.add(provider.providerId);
    return [{ providerId: provider.providerId, displayName: provider.displayName }];
  });
}

/** `get_claude_quota_setup` 的返回值。用来让设置页能直说「接没接上」。 */
interface ClaudeQuotaSetup {
  /** 完整的 statusLine 对象，可直接合并进 settings.json。 */
  settingsBlock: string;
  /** 兼容旧界面的 "command": … 单行片段。 */
  commandProperty: string;
  /** Claude Code settings.json 的绝对路径。 */
  settingsPath: string;
  /** statusLine 是否已指向本应用。 */
  statusLineWired: boolean;
  /** 是否已收到过至少一次快照。 */
  snapshotPresent: boolean;
  /** 内置 /usage 探针会依次尝试的 CLI。 */
  cliCandidates: string[];
  /** 一键接入留下的备份；没有写入过则为空。 */
  backup?: ClaudeStatuslineBackup | null;
  /** 原有 status line 是否由 TokenLedger 继续执行。 */
  chainPresent?: boolean;
}

interface ClaudeStatuslineBackup {
  createdAt: string;
  originalExisted: boolean;
  restorableWithoutForce: boolean;
}

/** `preview_claude_statusline_setup` 的返回值：只含 statusLine 的改动。 */
export interface ClaudeStatuslinePreview {
  settingsPath: string;
  fileExists: boolean;
  changed: boolean;
  keepsOriginal: boolean;
  beforeVersion: string;
  diff: string;
}

type ClaudeSetupAction = 'preview' | 'apply' | 'restore' | null;

function ClaudeSetupPreviewDialog({ preview, busy, onCancel, onConfirm }: {
  preview: ClaudeStatuslinePreview;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      const dialog = dialogRef.current;
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), pre[tabindex]'));
      if (focusable.length === 0) return;
      const wrapTarget = focusWrapTarget(
        event.shiftKey ? 'backward' : 'forward',
        document.activeElement === focusable[0],
        document.activeElement === focusable[focusable.length - 1],
      );
      if (wrapTarget === 'last') {
        event.preventDefault();
        focusable[focusable.length - 1].focus();
      } else if (wrapTarget === 'first') {
        event.preventDefault();
        focusable[0].focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      previous?.focus({ preventScroll: true });
    };
  }, []);

  const dialog = (
    <div
      className="modal-overlay confirm-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <section
        ref={dialogRef}
        className="modal-content confirm-dialog confirm-dialog-primary"
        role="dialog"
        aria-modal="true"
        aria-labelledby="claude-setup-preview-title"
        tabIndex={-1}
      >
        <div className="confirm-dialog-icon" aria-hidden="true">
          <FileDiff className="h-5 w-5" />
        </div>
        <div className="confirm-dialog-copy">
          <h2 id="claude-setup-preview-title" className="confirm-dialog-title">写入 Claude Code 配置？</h2>
          <p className="confirm-dialog-description">
            {preview.fileExists ? preview.settingsPath : `${preview.settingsPath}（新建）`}
          </p>
          {preview.changed ? (
            <pre className="settings-code settings-code-block" aria-label="statusLine 改动预览" tabIndex={0}>{preview.diff}</pre>
          ) : (
            <p className="confirm-dialog-description">已经接入，无需改动。</p>
          )}
          <p className="confirm-dialog-description">
            {preview.keepsOriginal ? '只改 statusLine；原有 status line 会保留并照常显示。' : '只改 statusLine，写入前自动备份。'}
          </p>
        </div>
        <footer className="confirm-dialog-actions">
          <button ref={cancelRef} className="ghost-inline" type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            className="primary-inline"
            type="button"
            onClick={onConfirm}
            disabled={busy || !preview.changed}
            aria-busy={busy || undefined}
          >
            {busy ? '写入中…' : '确认写入'}
          </button>
        </footer>
      </section>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(dialog, document.body) : dialog;
}

/** 本机额度告警（REQ-QUOTA-07）：默认关闭，只对百分比窗口生效。 */
function QuotaAlertsCard() {
  const { settings, loaded, saving, error, save } = useQuotaAlertSettings();
  const disabled = !loaded || saving;
  return (
    <SettingsCard title="额度提醒">
      <SettingsGroup>
        <SettingsToggleRow
          label="额度不足时提醒"
          hint="系统通知，每个窗口每档每周期一次。"
          icon={Bell}
          checked={settings.enabled}
          disabled={disabled}
          busy={saving}
          onChange={(enabled) => void save({ ...settings, enabled })}
        />
        <SettingsRow label="提醒档位" hint="剩余低于所选比例时提醒。">
          <div className="settings-inline-actions" role="group" aria-label="提醒档位">
            {QUOTA_ALERT_THRESHOLDS.map((threshold) => {
              const selected = settings.thresholds.includes(threshold);
              const onlySelected = selected && settings.thresholds.length === 1;
              return (
                <button
                  key={threshold}
                  type="button"
                  className={selected ? 'primary-inline' : 'secondary-inline'}
                  aria-pressed={selected}
                  disabled={disabled || !settings.enabled || onlySelected}
                  title={onlySelected ? '至少保留一档' : undefined}
                  onClick={() => void save({
                    ...settings,
                    thresholds: toggleQuotaAlertThreshold(settings.thresholds, threshold),
                  })}
                >
                  {threshold}%
                </button>
              );
            })}
          </div>
        </SettingsRow>
        {error && <p className="settings-error" role="alert">{error}</p>}
      </SettingsGroup>
    </SettingsCard>
  );
}

export function QuotaSection(props: QuotaSectionProps) {
  const { appSettings, busy, cloudStatus, quotaSyncStatus } = props;
  const [claudeStatuslineCommand, setClaudeStatuslineCommand] = useState('正在读取当前客户端路径…');
  const [claudeSetup, setClaudeSetup] = useState<ClaudeQuotaSetup | null>(null);
  const [claudeSetupReloadKey, setClaudeSetupReloadKey] = useState(0);
  const [statuslineCopyState, setStatuslineCopyState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const [claudePreview, setClaudePreview] = useState<ClaudeStatuslinePreview | null>(null);
  const [claudeSetupAction, setClaudeSetupAction] = useState<ClaudeSetupAction>(null);
  const [claudeSetupError, setClaudeSetupError] = useState('');
  const [claudeSetupNotice, setClaudeSetupNotice] = useState('');
  const [customEndpoints, setCustomEndpoints] = useState<CustomQuotaEndpointView[]>([]);
  const [customEndpointError, setCustomEndpointError] = useState('');
  const [customEndpointBusy, setCustomEndpointBusy] = useState(false);
  const [activeCustomEndpointAction, setActiveCustomEndpointAction] = useState<CustomEndpointAction>(null);
  const [activeQuotaSnapshotAction, setActiveQuotaSnapshotAction] = useState<QuotaSnapshotAction>(null);
  const [quotaSnapshotFocusRestoreVersion, setQuotaSnapshotFocusRestoreVersion] = useState(0);
  const quotaSnapshotActionInFlightRef = useRef(false);
  const quotaSnapshotFocusTargetRef = useRef<HTMLButtonElement | null>(null);
  const quotaSectionMountedRef = useRef(true);
  const [customEditingId, setCustomEditingId] = useState<string | null>(null);
  const [customName, setCustomName] = useState('');
  const [customUrl, setCustomUrl] = useState('https://your-gateway.example.com/v1/me/quota');
  const [customApiKey, setCustomApiKey] = useState('');
  const [activeQuotaRead, setActiveQuotaRead] = useState<'claude' | 'antigravity' | null>(null);
  const orphanedCustomProviders = orphanedCustomQuotaProviders(customEndpoints, props.quotaProviders);

  const [sourceDetections, setSourceDetections] = useState<Map<string, QuotaSourceDetection>>(() => new Map());
  const [now, setNow] = useState(() => Date.now());

  const codexSignal = useFirstEnableSignal(appSettings.quota_codex_local_enabled);
  const claudeSignal = useFirstEnableSignal(appSettings.quota_claude_enabled);
  const antigravitySignal = useFirstEnableSignal(appSettings.quota_antigravity_local_enabled);
  const syncSignal = useFirstEnableSignal(appSettings.quota_snapshot_sync_enabled);

  const quotaSyncRecoveryMessage = quotaSyncCapacityMessage(quotaSyncStatus)
    ?? (quotaSyncStatus.reasonCode === 'quota_sync_remote_clear_incomplete'
      || quotaSyncStatus.reasonCode?.startsWith('quota_sync_clear_')
      ? quotaClearFeedback(quotaSyncStatus).message
      : undefined);
  const quotaSyncLabel = (() => {
    if (quotaSyncRecoveryMessage) return quotaSyncRecoveryMessage;
    switch (quotaSyncStatus.state) {
      case 'active': return quotaSyncStatus.lastSyncedAt ? '已同步' : '已启用，等待首个快照';
      case 'syncing': return '正在同步';
      case 'paused': return '已暂停，需要重新显式启用';
      case 'auth-required': return '等待云端登录';
      case 'unavailable': return '云端能力尚未部署';
      case 'error': return '最近一次同步失败';
      default: return '未启用';
    }
  })();
  const quotaSyncBusy = quotaSyncStatus.state === 'syncing';
  const quotaSyncButtonLabel = quotaSyncBusy ? '同步中…' : '同步额度';
  const quotaSyncButtonAriaLabel = quotaSyncBusy ? '正在同步额度' : '同步额度';
  const quotaSyncActionDisabledReason = busy.settings
    ? '正在保存设置，请稍候'
    : quotaSyncBusy
      ? '正在同步额度，请稍候'
      : !appSettings.quota_snapshot_sync_enabled
        ? cloudStatus.authenticated
          ? '请先启用跨设备同步'
          : '请先登录云端账户，再启用跨设备同步'
        : undefined;
  const quotaSyncButtonTitle = quotaSyncActionDisabledReason
    ? `${quotaSyncButtonAriaLabel}：${quotaSyncActionDisabledReason}`
    : '立即同步已授权的额度快照';
  const claudeReadBusy = activeQuotaRead === 'claude' && busy.settings;
  const antigravityReadBusy = activeQuotaRead === 'antigravity' && busy.settings;
  const providerById = (providerId: string) => props.quotaProviders.find((provider) => provider.providerId === providerId);
  const installedById = (providerId: string) => sourceDetections.get(providerId)?.installed ?? null;
  const codexInstalled = installedById('openai-codex-local');
  const claudeInstalled = installedById('anthropic-claude-consumer');
  const antigravityInstalled = installedById('google-antigravity-consumer');
  const codexView = quotaSourceCardView({
    name: 'Codex',
    enabled: appSettings.quota_codex_local_enabled,
    installed: codexInstalled,
    provider: providerById('openai-codex-local'),
    now,
  });
  const claudeBaseView = quotaSourceCardView({
    name: 'Claude Code',
    enabled: appSettings.quota_claude_enabled,
    installed: claudeInstalled,
    provider: providerById('anthropic-claude-consumer'),
    now,
  });
  const claudeView: QuotaSourceCardView = appSettings.quota_claude_enabled
    && claudeBaseView.state === 'needs-authorization'
    && claudeSetup
    && !claudeSetup.statusLineWired
    ? { ...claudeBaseView, sentence: '还没接入 Claude Code，用下方「一键接入」完成。' }
    : claudeBaseView;
  const antigravityView = quotaSourceCardView({
    name: 'Antigravity',
    enabled: appSettings.quota_antigravity_local_enabled,
    installed: antigravityInstalled,
    provider: providerById('google-antigravity-consumer'),
    now,
  });
  const overview = quotaOverviewSummary(
    appSettings,
    customEndpoints,
    quotaSyncLabel,
    [codexView.state, claudeView.state, antigravityView.state],
  );

  useEffect(() => {
    if (!busy.settings) setActiveQuotaRead(null);
  }, [busy.settings]);

  useEffect(() => {
    let active = true;
    invoke<unknown>('detect_quota_sources')
      .then((value) => {
        if (active) setSourceDetections(parseQuotaSourceDetections(value));
      })
      .catch(() => {
        // 检测失败只意味着不置灰开关，不影响读取。
      });
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (busy.settings || activeQuotaSnapshotAction !== null) return;

    const target = quotaSnapshotFocusTargetRef.current;
    quotaSnapshotFocusTargetRef.current = null;
    if (!target?.isConnected || target.disabled) return;

    const activeElement = document.activeElement;
    if (activeElement === document.body || activeElement === document.documentElement || activeElement === null) {
      target.focus({ preventScroll: true });
    }
  }, [activeQuotaSnapshotAction, busy.settings, quotaSnapshotFocusRestoreVersion]);

  useEffect(() => {
    quotaSectionMountedRef.current = true;
    return () => {
      quotaSectionMountedRef.current = false;
      quotaSnapshotFocusTargetRef.current = null;
    };
  }, []);

  const runQuotaRead = (provider: 'claude' | 'antigravity') => {
    if (busy.settings) return;
    setActiveQuotaRead(provider);
    if (provider === 'claude') props.onAuthorizeClaudeNativeQuota();
    else props.onAuthorizeAntigravityQuota();
  };

  useEffect(() => {
    let active = true;
    invoke<ClaudeQuotaSetup>('get_claude_quota_setup')
      .then((setup) => {
        if (!active) return;
        setClaudeStatuslineCommand(setup.commandProperty);
        setClaudeSetup(setup);
      })
      .catch(() => {
        if (active) setClaudeStatuslineCommand('无法读取当前客户端路径');
      });
    return () => {
      active = false;
    };
    // claudeSetupReloadKey 在「立即读取」之后自增，用来重新确认接入状态。
  }, [claudeSetupReloadKey]);

  const loadCustomEndpoints = async () => {
    try {
      const endpoints = await invoke<CustomQuotaEndpointView[]>('list_custom_quota_endpoints');
      setCustomEndpoints(endpoints);
      setCustomEndpointError('');
    } catch (error) {
      setCustomEndpointError(String(error));
    }
  };

  useEffect(() => {
    void loadCustomEndpoints();
  }, []);

  const resetCustomEditor = () => {
    setCustomEditingId(null);
    setCustomName('');
    setCustomUrl('https://your-gateway.example.com/v1/me/quota');
    setCustomApiKey('');
  };

  const saveCustomEndpoint = async (event: FormEvent) => {
    event.preventDefault();
    setCustomEndpointBusy(true);
    setCustomEndpointError('');
    try {
      const endpoints = await invoke<CustomQuotaEndpointView[]>('upsert_custom_quota_endpoint', {
        input: {
          ...(customEditingId ? { id: customEditingId } : {}),
          displayName: customName,
          url: customUrl,
          ...(customApiKey ? { apiKey: customApiKey } : {}),
          enabled: customEditingId
            ? customEndpoints.find((endpoint) => endpoint.id === customEditingId)?.enabled ?? true
            : true,
        },
      });
      setCustomEndpoints(endpoints);
      resetCustomEditor();
      props.onCustomQuotaChanged();
    } catch (error) {
      setCustomEndpointError(String(error));
    } finally {
      setCustomEndpointBusy(false);
    }
  };

  const editCustomEndpoint = (endpoint: CustomQuotaEndpointView) => {
    setCustomEditingId(endpoint.id);
    setCustomName(endpoint.displayName);
    setCustomUrl(endpoint.url);
    setCustomApiKey('');
    setCustomEndpointError('');
  };

  const toggleCustomEndpoint = async (endpoint: CustomQuotaEndpointView) => {
    setActiveCustomEndpointAction({ kind: 'toggle', id: endpoint.id });
    setCustomEndpointBusy(true);
    setCustomEndpointError('');
    try {
      const endpoints = await invoke<CustomQuotaEndpointView[]>('upsert_custom_quota_endpoint', {
        input: {
          id: endpoint.id,
          displayName: endpoint.displayName,
          url: endpoint.url,
          enabled: !endpoint.enabled,
        },
      });
      setCustomEndpoints(endpoints);
      props.onCustomQuotaChanged();
    } catch (error) {
      setCustomEndpointError(String(error));
    } finally {
      setCustomEndpointBusy(false);
      setActiveCustomEndpointAction(null);
    }
  };

  const deleteCustomEndpoint = async (endpoint: CustomQuotaEndpointView) => {
    if (!(await props.onConfirm({
      title: `删除“${endpoint.displayName}”的本机额度来源？`,
      description: '本机地址与 API key 会被删除，云端历史快照不会被隐式删除。',
      confirmLabel: '删除来源',
      tone: 'danger',
    }))) return;
    setActiveCustomEndpointAction({ kind: 'delete', id: endpoint.id });
    setCustomEndpointBusy(true);
    setCustomEndpointError('');
    try {
      const endpoints = await invoke<CustomQuotaEndpointView[]>('delete_custom_quota_endpoint', {
        id: endpoint.id,
      });
      setCustomEndpoints(endpoints);
      if (customEditingId === endpoint.id) resetCustomEditor();
      props.onCustomQuotaChanged();
    } catch (error) {
      setCustomEndpointError(String(error));
    } finally {
      setCustomEndpointBusy(false);
      setActiveCustomEndpointAction(null);
    }
  };

  const customEndpointActionBusy = (kind: Exclude<CustomEndpointAction, null>['kind'], id: string) =>
    customEndpointBusy && activeCustomEndpointAction?.kind === kind && activeCustomEndpointAction.id === id;
  const customEndpointSaveBusy = customEndpointBusy && activeCustomEndpointAction === null;
  const customEndpointSaveLabel = customEndpointSaveBusy
    ? customEditingId ? '正在保存公司额度来源' : '正在添加公司额度来源'
    : customEditingId ? '保存修改并刷新额度' : '添加并刷新额度';
  const customEndpointSaveTitle = customEndpointSaveBusy
    ? `${customEndpointSaveLabel}，请稍候`
    : customEndpointSaveLabel;

  const beginQuotaSnapshotAction = (trigger: HTMLButtonElement) => {
    if (busy.settings || quotaSnapshotActionInFlightRef.current) return false;
    quotaSnapshotActionInFlightRef.current = true;
    quotaSnapshotFocusTargetRef.current = document.activeElement === trigger ? trigger : null;
    return true;
  };

  const runDeleteQuotaSnapshot = async (providerId: string, scope: string, trigger: HTMLButtonElement) => {
    if (!beginQuotaSnapshotAction(trigger)) return;
    setActiveQuotaSnapshotAction({ kind: 'provider', providerId });
    try {
      await props.onDeleteQuotaProvider(providerId, scope);
    } catch {
      // 失败提示由上层删除流程负责，本地只需释放动作锁与恢复入口。
    } finally {
      quotaSnapshotActionInFlightRef.current = false;
      if (quotaSectionMountedRef.current) {
        setActiveQuotaSnapshotAction(null);
        setQuotaSnapshotFocusRestoreVersion((version) => version + 1);
      }
    }
  };

  const runClearQuotaSnapshots = async (trigger: HTMLButtonElement) => {
    if (!beginQuotaSnapshotAction(trigger)) return;
    setActiveQuotaSnapshotAction({ kind: 'all' });
    try {
      await props.onClearQuotaSnapshots();
    } catch {
      // 失败提示由上层删除流程负责，本地只需释放动作锁与恢复入口。
    } finally {
      quotaSnapshotActionInFlightRef.current = false;
      if (quotaSectionMountedRef.current) {
        setActiveQuotaSnapshotAction(null);
        setQuotaSnapshotFocusRestoreVersion((version) => version + 1);
      }
    }
  };

  const quotaSnapshotProviderBusy = (providerId: string) =>
    activeQuotaSnapshotAction?.kind === 'provider' && activeQuotaSnapshotAction.providerId === providerId;
  const quotaSnapshotBusy = activeQuotaSnapshotAction !== null;
  const quotaSnapshotAllBusy = activeQuotaSnapshotAction?.kind === 'all';

  // 复制的是完整的 statusLine 对象，不是 "command" 单行片段——片段无法直接使用，
  // 是「照着做了却接不上」的直接原因。
  const claudeStatuslineBlock = claudeSetup?.settingsBlock ?? '';
  const claudeStatuslineReady = claudeStatuslineBlock.includes('--claude-statusline');

  const copyClaudeStatuslineCommand = async () => {
    if (!claudeStatuslineReady) return;
    try {
      await navigator.clipboard.writeText(claudeStatuslineBlock);
      setStatuslineCopyState('copied');
      window.setTimeout(() => setStatuslineCopyState('idle'), 1_800);
    } catch {
      setStatuslineCopyState('manual');
      window.setTimeout(() => setStatuslineCopyState('idle'), 2_400);
    }
  };

  const claudeBackup = claudeSetup?.backup ?? null;

  const previewClaudeSetup = async () => {
    if (claudeSetupAction) return;
    setClaudeSetupAction('preview');
    setClaudeSetupError('');
    setClaudeSetupNotice('');
    try {
      setClaudePreview(await invoke<ClaudeStatuslinePreview>('preview_claude_statusline_setup'));
    } catch (error) {
      setClaudeSetupError(String(error));
    } finally {
      setClaudeSetupAction(null);
    }
  };

  const applyClaudeSetup = async () => {
    if (!claudePreview || claudeSetupAction) return;
    setClaudeSetupAction('apply');
    setClaudeSetupError('');
    try {
      await invoke('apply_claude_statusline_setup', { expectedVersion: claudePreview.beforeVersion });
      setClaudeSetupNotice('已写入，新开 Claude Code 会话后生效');
    } catch (error) {
      setClaudeSetupError(String(error));
    } finally {
      setClaudePreview(null);
      setClaudeSetupAction(null);
      setClaudeSetupReloadKey((key) => key + 1);
    }
  };

  const restoreClaudeSetup = async () => {
    if (!claudeBackup || claudeSetupAction) return;
    const force = !claudeBackup.restorableWithoutForce;
    const confirmed = await props.onConfirm(force
      ? {
          title: '强制恢复 Claude 原配置？',
          description: '接入后 statusLine 又被改过，恢复会换回接入前的 statusLine，丢掉这项改动；其他设置不受影响。',
          confirmLabel: '强制恢复',
          tone: 'danger',
        }
      : {
          title: '恢复 Claude 原配置？',
          description: claudeBackup.originalExisted
            ? 'statusLine 会换回接入前的样子，其他设置保持现状。'
            : '会去掉 TokenLedger 写入的 statusLine；接入时新建的 settings.json 若没有别的内容会一并删除。',
          confirmLabel: '恢复',
        });
    if (!confirmed) return;
    setClaudeSetupAction('restore');
    setClaudeSetupError('');
    setClaudeSetupNotice('');
    try {
      await invoke('restore_claude_statusline_setup', { force });
      setClaudeSetupNotice('已恢复原配置');
    } catch (error) {
      setClaudeSetupError(String(error));
    } finally {
      setClaudeSetupAction(null);
      setClaudeSetupReloadKey((key) => key + 1);
    }
  };

  return (
    <SettingsSection id="quota" title="订阅额度">
      <section className="quota-overview" aria-label="额度配置总览">
        <div className="quota-overview-head">
          <div>
            <span className="quota-overview-kicker">先看状态，再配置来源</span>
            <h3>额度来源总览</h3>
            <p>只展示来源实际返回的额度，不推算、不补齐。</p>
          </div>
          <span className={`quota-overview-badge${overview.localConnectedCount + overview.companyEnabledCount > 0 ? ' is-active' : ''}`}>
            {overview.localAttentionCount > 0
              ? '有来源需处理'
              : overview.localConnectedCount + overview.companyEnabledCount > 0 ? '有来源已连接' : '等待授权'}
          </span>
        </div>
        <div className="quota-overview-grid">
          <div className="quota-overview-item">
            <span>本机订阅已连接</span>
            <strong>{overview.localConnectedCount}/3</strong>
            <small>
              {overview.localEnabledCount > 0 ? `${overview.localEnabledCount} 个已开启` : '尚未开启'}
              {overview.localAttentionCount > 0 ? ` · ${overview.localAttentionCount} 个需处理` : ''}
            </small>
          </div>
          <div className="quota-overview-item">
            <span>公司 OpenAPI</span>
            <strong>{overview.companyConfiguredCount > 0 ? `${overview.companyEnabledCount}/${overview.companyConfiguredCount}` : '—'}</strong>
            <small>{overview.companyConfiguredCount > 0 ? `${overview.companyConfiguredCount} 个配置 · ${overview.companyEnabledCount} 个启用` : '尚未配置来源'}</small>
          </div>
          <div className="quota-overview-item">
            <span>跨设备同步</span>
            <strong>{overview.syncLabel}</strong>
            <small>独立授权，默认关闭</small>
          </div>
        </div>
      </section>
      <SettingsCard title="Codex">
        <QuotaSourceStatus
          providerId="openai-codex-local"
          name="Codex"
          view={codexView}
          readLabel="立即读取 Codex 额度"
          readBusyLabel="正在读取 Codex 额度"
          readBusy={false}
          readDisabled
        />
        <SettingsGroup>
          <SettingsToggleRow
            label="读取 Codex 额度"
            hint="走 Codex 官方本地接口，不读取 OAuth Token。"
            icon={Gauge}
            checked={appSettings.quota_codex_local_enabled}
            disabled={busy.settings || (codexInstalled === false && !appSettings.quota_codex_local_enabled)}
            busy={busy.settings}
            onChange={(checked) => props.onSettingChange('quota_codex_local_enabled', checked)}
          />
          <DisclosurePanel ariaLabel="Codex：权限与数据边界" openSignal={codexSignal}>
            <p>通过 Codex 官方 app-server 读取当前账户的额度窗口，不读取或复用 OAuth Token，不上传账户数据。</p>
            <p>旧版 Codex 没有 app-server 时，才受限读取 session 尾部的 rate_limits 字段，并标为实验性。</p>
          </DisclosurePanel>
        </SettingsGroup>
      </SettingsCard>

      <SettingsCard title="Claude">
        <QuotaSourceStatus
          providerId="anthropic-claude-consumer"
          name="Claude"
          view={claudeView}
          readLabel="立即读取 Claude 订阅额度"
          readBusyLabel="正在读取 Claude 订阅额度"
          readBusy={claudeReadBusy}
          readDisabled={busy.settings}
          onRead={appSettings.quota_claude_codexbar_enabled
            ? () => { setClaudeSetupReloadKey((key) => key + 1); runQuotaRead('claude'); }
            : undefined}
        />
        <SettingsGroup>
          <SettingsToggleRow
            label="读取 Claude 额度"
            hint="自动选择来源，Claude Code status line 优先。"
            icon={Gauge}
            checked={appSettings.quota_claude_enabled}
            disabled={busy.settings || (claudeInstalled === false && !appSettings.quota_claude_enabled)}
            busy={busy.settings}
            onChange={(checked) => props.onSettingChange('quota_claude_enabled', checked)}
          />
          <SettingsRow
            label="一键接入"
            hint={claudeSetupNotice || (claudeSetup?.statusLineWired
              ? claudeSetup.chainPresent ? '原 status line 照常显示，可随时恢复。' : '已写入 statusLine，可随时恢复。'
              : appSettings.quota_claude_enabled
                ? '只改 settings.json 的 statusLine，写入前先预览。'
                : '先打开上面的开关。')}
            busy={claudeSetupAction !== null}
          >
            <div className="settings-inline-actions">
              {!claudeSetup?.statusLineWired && (
                <button
                  className="secondary-inline"
                  type="button"
                  disabled={!claudeSetup || !appSettings.quota_claude_enabled || claudeSetupAction !== null}
                  aria-busy={claudeSetupAction === 'preview' || undefined}
                  onClick={() => void previewClaudeSetup()}
                >
                  {claudeSetupAction === 'preview' && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                  {claudeSetupAction === 'preview' ? '读取中…' : '一键接入'}
                </button>
              )}
              {claudeBackup && (
                <button
                  className="secondary-inline"
                  type="button"
                  disabled={claudeSetupAction !== null}
                  aria-busy={claudeSetupAction === 'restore' || undefined}
                  onClick={() => void restoreClaudeSetup()}
                >
                  {claudeSetupAction === 'restore' && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                  {claudeSetupAction === 'restore' ? '恢复中…' : '恢复原配置'}
                </button>
              )}
            </div>
          </SettingsRow>
          {claudeSetupError && <p className="settings-error" role="alert">{claudeSetupError}</p>}
          <DisclosurePanel title="手动配置" ariaLabel="Claude：手动配置" decorative>
            <p>
              {claudeSetup?.settingsPath
                ? `把下面这段合并进 ${claudeSetup.settingsPath}（最外层），保存后新开一个 Claude Code 会话生效。`
                : '把下面这段合并进 Claude Code 的 settings.json 最外层，保存后新开一个会话生效。'}
            </p>
            <pre className="settings-code settings-code-block" aria-label="statusLine 配置">{claudeStatuslineBlock || claudeStatuslineCommand}</pre>
            <button
              className="secondary-inline"
              type="button"
              onClick={copyClaudeStatuslineCommand}
              disabled={!claudeStatuslineReady}
            >
              {statuslineCopyState === 'copied' ? '已复制' : statuslineCopyState === 'manual' ? '请手动复制' : '复制完整配置'}
            </button>
          </DisclosurePanel>
          <DisclosurePanel title="高级" ariaLabel="Claude：高级" decorative>
            <SettingsToggleRow
              label="实验来源：内置 /usage 与 CodexBar"
              hint="默认不参与。status line 缺数据时补位，开启后立即读取一次。"
              icon={FlaskConical}
              checked={appSettings.quota_claude_codexbar_enabled}
              disabled={busy.settings || !appSettings.quota_claude_enabled}
              busy={busy.settings}
              onChange={props.onClaudeNativeQuotaChange}
            />
            {appSettings.quota_claude_codexbar_enabled && (
              <SettingsRow label="内置 /usage 探针" hint="依次尝试下列 CLI。" wideControl>
                {claudeSetup && claudeSetup.cliCandidates.length === 0 ? (
                  <span className="settings-value quota-setup-stage quota-setup-stage-blocked">
                    本机找不到 Claude CLI，内置 /usage 无法工作
                  </span>
                ) : (
                  <ul className="quota-cli-candidates">
                    {(claudeSetup?.cliCandidates ?? []).map((candidate) => (
                      <li key={candidate}><code>{candidate}</code></li>
                    ))}
                  </ul>
                )}
              </SettingsRow>
            )}
          </DisclosurePanel>
          <DisclosurePanel ariaLabel="Claude：权限与数据边界" openSignal={claudeSignal}>
            <p>只接收 Claude Code 通过 status line 交出的官方 rate_limits 字段，不保存 cwd、session_id 或原始输入；不读钥匙串、Cookie 或 OAuth Token。</p>
            <p>一键接入只改 settings.json 的 statusLine 一项，写入前备份；原有 status line 由 TokenLedger 继续执行并原样显示，可一键恢复。</p>
          </DisclosurePanel>
        </SettingsGroup>
      </SettingsCard>
      {claudePreview && (
        <ClaudeSetupPreviewDialog
          preview={claudePreview}
          busy={claudeSetupAction === 'apply'}
          onCancel={() => { if (claudeSetupAction !== 'apply') setClaudePreview(null); }}
          onConfirm={() => void applyClaudeSetup()}
        />
      )}

      <SettingsCard title="Antigravity">
        <QuotaSourceStatus
          providerId="google-antigravity-consumer"
          name="Antigravity"
          view={antigravityView}
          readLabel="立即读取 Antigravity 额度"
          readBusyLabel="正在读取 Antigravity 额度"
          readBusy={antigravityReadBusy}
          readDisabled={busy.settings}
          onRead={appSettings.quota_antigravity_local_enabled ? () => runQuotaRead('antigravity') : undefined}
        />
        <SettingsGroup>
          <SettingsToggleRow
            label="读取 Antigravity 额度"
            hint="实验性，只连接本机正在运行的 Antigravity。"
            icon={Gauge}
            checked={appSettings.quota_antigravity_local_enabled}
            disabled={busy.settings || (antigravityInstalled === false && !appSettings.quota_antigravity_local_enabled)}
            busy={busy.settings}
            onChange={props.onAntigravityLocalQuotaChange}
          />
          <DisclosurePanel title="高级" ariaLabel="Antigravity：高级" decorative>
            <SettingsToggleRow
              label="CodexBar 兜底"
              hint="默认不参与。内置读取失败后才调用 CodexBar CLI。"
              icon={FlaskConical}
              checked={appSettings.quota_antigravity_codexbar_enabled}
              disabled={busy.settings || !appSettings.quota_antigravity_local_enabled}
              busy={busy.settings}
              onChange={(checked) => props.onSettingChange('quota_antigravity_codexbar_enabled', checked)}
            />
          </DisclosurePanel>
          <DisclosurePanel ariaLabel="Antigravity：权限与数据边界" openSignal={antigravitySignal}>
            <p>只请求当前用户 Antigravity App、IDE 或 agy 的 127.0.0.1 本地服务，不读取 Cookie、云端 OAuth Token 或账户身份。</p>
            <p>CodexBar 兜底固定为 local/cli 来源，不允许远端 OAuth 抓取。</p>
          </DisclosurePanel>
        </SettingsGroup>
      </SettingsCard>
      <QuotaExperimentalPlansCard
        quotaProviders={props.quotaProviders}
        now={now}
        disabled={busy.settings}
        onChanged={props.onCustomQuotaChanged}
      />
      <SettingsCard title="公司 OpenAPI">
        <SettingsGroup>
          {customEndpoints.length === 0 && (
            <SettingsRow label="尚未配置" hint="可以添加 2～3 组不同地址和对应 API key，最多 5 组。">
              <span className="settings-value">没有公司额度来源</span>
            </SettingsRow>
          )}
          {customEndpoints.map((endpoint) => {
            const toggleBusy = customEndpointActionBusy('toggle', endpoint.id);
            const deleteBusy = customEndpointActionBusy('delete', endpoint.id);
            const cloudDeleteBusy = quotaSnapshotProviderBusy(endpoint.providerId);
            const toggleLabel = endpoint.enabled ? '停用' : '启用';
            const toggleBusyLabel = endpoint.enabled ? '正在停用' : '正在启用';
            const apiKeyLabel = endpoint.hasApiKey === true
              ? 'key 已安全保存'
              : endpoint.hasApiKey === false
                ? '缺少 key'
                : 'key 状态待检查';
            return (
              <SettingsRow
                key={endpoint.id}
                label={endpoint.displayName}
                hint={endpoint.url}
                icon={KeyRound}
                wideControl
              >
              <div className="settings-inline-actions">
                <span className="settings-value">
                  {endpoint.enabled ? '已启用' : '已停用'} · {apiKeyLabel} · {endpoint.schemaVerified ? '响应格式已验证' : '响应格式待实测（仅本机）'}
                </span>
                <button
                  className="secondary-inline"
                  type="button"
                  disabled={customEndpointBusy || busy.settings}
                  onClick={() => void toggleCustomEndpoint(endpoint)}
                  aria-label={toggleBusy ? `${toggleBusyLabel} ${endpoint.displayName}` : `${toggleLabel} ${endpoint.displayName}`}
                  aria-busy={toggleBusy || undefined}
                  title={toggleBusy ? `${toggleBusyLabel} ${endpoint.displayName}` : `${toggleLabel} ${endpoint.displayName}`}
                >
                  {toggleBusy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                  {toggleBusy ? '处理中…' : toggleLabel}
                </button>
                <button
                  className="secondary-inline"
                  type="button"
                  disabled={customEndpointBusy || busy.settings}
                  onClick={() => editCustomEndpoint(endpoint)}
                  aria-label={`编辑 ${endpoint.displayName} 公司额度来源`}
                  title={`编辑 ${endpoint.displayName} 公司额度来源`}
                >
                  编辑
                </button>
                <button
                  className="secondary-inline"
                  type="button"
                  disabled={customEndpointBusy || busy.settings || !cloudStatus.authenticated || quotaSnapshotBusy}
                  onClick={(event: ReactMouseEvent<HTMLButtonElement>) => void runDeleteQuotaSnapshot(
                    endpoint.providerId,
                    'api-organization',
                    event.currentTarget,
                  )}
                  aria-label={cloudDeleteBusy ? `正在删除 ${endpoint.displayName} 云端快照` : `删除 ${endpoint.displayName} 云端快照`}
                  aria-busy={cloudDeleteBusy || undefined}
                  title={cloudDeleteBusy ? `正在删除 ${endpoint.displayName} 云端快照` : `删除 ${endpoint.displayName} 云端快照`}
                >
                  {cloudDeleteBusy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                  {cloudDeleteBusy ? '删除中…' : '删除云端快照'}
                </button>
                <button
                  className="danger-inline"
                  type="button"
                  disabled={customEndpointBusy || busy.settings}
                  onClick={() => void deleteCustomEndpoint(endpoint)}
                  aria-label={deleteBusy ? `正在删除本机配置 ${endpoint.displayName}` : `删除本机配置 ${endpoint.displayName}`}
                  aria-busy={deleteBusy || undefined}
                  title={deleteBusy ? `正在删除本机配置 ${endpoint.displayName}` : `删除本机配置 ${endpoint.displayName}`}
                >
                  {deleteBusy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                  {deleteBusy ? '删除中…' : '删除本机配置'}
                </button>
              </div>
              </SettingsRow>
            );
          })}
          {orphanedCustomProviders.map((provider) => {
            const cloudDeleteBusy = quotaSnapshotProviderBusy(provider.providerId);
            return (
              <SettingsRow
                key={provider.providerId}
                label={provider.displayName}
                hint="本机配置已删除，仅保留云端历史快照。"
                icon={Cloud}
                wideControl
              >
                <div className="settings-inline-actions">
                  <span className="settings-value">云端历史</span>
                  <button
                    className="danger-inline"
                    type="button"
                    disabled={customEndpointBusy || busy.settings || !cloudStatus.authenticated || quotaSnapshotBusy}
                    onClick={(event: ReactMouseEvent<HTMLButtonElement>) => void runDeleteQuotaSnapshot(
                      provider.providerId,
                      'api-organization',
                      event.currentTarget,
                    )}
                    aria-label={cloudDeleteBusy ? `正在删除 ${provider.displayName} 云端快照` : `删除 ${provider.displayName} 云端快照`}
                    aria-busy={cloudDeleteBusy || undefined}
                    title={cloudDeleteBusy ? `正在删除 ${provider.displayName} 云端快照` : `删除 ${provider.displayName} 云端快照`}
                  >
                    {cloudDeleteBusy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                    {cloudDeleteBusy ? '删除中…' : '删除这条云端快照'}
                  </button>
                </div>
              </SettingsRow>
            );
          })}

          <form onSubmit={saveCustomEndpoint}>
            <SettingsRow
              label={customEditingId ? '编辑公司额度来源' : '新增公司额度来源'}
              hint="名称会显示在桌面额度卡、Android 额度页、全屏摆件和 Launcher 小组件。"
              icon={Plus}
              wideControl
              busy={customEndpointSaveBusy}
            >
              <input
                className="settings-input"
                value={customName}
                onChange={(event) => setCustomName(event.target.value)}
                placeholder="例如：研发账号额度"
                maxLength={40}
                required
                aria-label="公司额度来源名称"
              />
            </SettingsRow>
            <SettingsRow label="查询接口地址" hint="填写完整地址；只填 HTTPS 域名时会自动补 /v1/me/quota。" wideControl>
              <input
                className="settings-input"
                value={customUrl}
                onChange={(event) => setCustomUrl(event.target.value)}
                placeholder="https://your-gateway.example.com/v1/me/quota"
                inputMode="url"
                required
                aria-label="公司额度查询接口地址"
              />
            </SettingsRow>
            <SettingsRow
              label="API key"
              hint={customEditingId ? '留空会保留原 key；输入新值才会替换。' : '只写入当前电脑的系统安全存储，不进入设置文件或云端。'}
              wideControl
            >
              <input
                className="settings-input"
                type="password"
                value={customApiKey}
                onChange={(event) => setCustomApiKey(event.target.value)}
                placeholder={customEditingId ? '留空保留现有 key' : '输入 API key'}
                autoComplete="new-password"
                required={!customEditingId}
                aria-label="公司额度 API key"
              />
              <div className="settings-inline-actions">
                <button
                  className="secondary-inline"
                  type="submit"
                  disabled={customEndpointBusy || busy.settings || (customEndpoints.length >= 5 && !customEditingId)}
                  aria-busy={customEndpointSaveBusy || undefined}
                  aria-label={customEndpointSaveLabel}
                  title={customEndpointSaveTitle}
                >
                  {customEndpointSaveBusy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                  {customEndpointSaveBusy ? '保存中…' : customEditingId ? '保存修改并刷新额度' : '添加并刷新额度'}
                </button>
                {customEditingId && (
                  <button className="secondary-inline" type="button" disabled={customEndpointBusy} onClick={resetCustomEditor}>
                    取消编辑
                  </button>
                )}
              </div>
            </SettingsRow>
          </form>
          {customEndpointError && <p className="settings-error" role="alert">{customEndpointError}</p>}
          <DisclosurePanel ariaLabel="公司 OpenAPI：权限与数据边界" openSignal={customEndpoints.length + orphanedCustomProviders.length}>
            <p>打开设置只读取配置元数据，不读取已保存的 API key；旧配置会显示“key 状态待检查”。设置内只有启用、保存或删除等明确动作，以及已启用来源的额度读取/同步，才会访问系统安全存储。</p>
            <p>每个配置使用独立稳定 Provider ID，因此 2～3 个接口会分别显示；删除本机配置后，仍可在这里单独删除对应的云端历史。</p>
            <p>请求固定使用 <code>Authorization: Bearer</code>，禁止重定向、URL 凭据、query key 和非本机明文 HTTP；响应最多读取 256 KiB。</p>
            <p>已用百分比直接按同一人民币单位计算：Key 当日消耗 ÷ Key 当日有效上限，用户日/月消耗 ÷ 对应日/月上限。只同步换算后的百分比，不上传金额、URL、API key 或原始响应。</p>
            <p>余额缺少总额，接口自带综合比率含义也未确认，因此两者都不用于百分比；Key 过期时间不冒充额度重置时间。</p>
          </DisclosurePanel>
        </SettingsGroup>
      </SettingsCard>

      <QuotaBalanceCard
        quotaProviders={props.quotaProviders}
        now={now}
        disabled={busy.settings}
        onChanged={props.onCustomQuotaChanged}
      />
      <QuotaAlertsCard />

      <SettingsCard title="跨设备同步">
        <SettingsGroup>
          <SettingsToggleRow
            label="同步脱敏额度快照到我的设备"
            hint="第二层独立授权，默认关闭。只同步契约校验过的额度窗口。"
            icon={Cloud}
            checked={appSettings.quota_snapshot_sync_enabled}
            disabled={busy.settings || (!appSettings.quota_snapshot_sync_enabled && !cloudStatus.authenticated)}
            busy={busy.settings}
            onChange={props.onQuotaSyncToggle}
          />
          <SettingsRow label="跨设备同步状态" hint="停用或撤权只停止这台设备，云端历史仍保留。" busy={quotaSyncBusy} wideControl={Boolean(quotaSyncRecoveryMessage)}>
            <span
              className="settings-value"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              style={quotaSyncRecoveryMessage ? { display: 'block', overflow: 'visible', WebkitLineClamp: 'unset' } : undefined}
            >{quotaSyncLabel}</span>
            {quotaSyncActionDisabledReason && (
              <span className="sr-only" id="quota-sync-action-hint">{quotaSyncActionDisabledReason}</span>
            )}
            <button
              className="secondary-inline"
              type="button"
              onClick={props.onQuotaSyncNow}
              aria-label={quotaSyncButtonAriaLabel}
              aria-describedby={quotaSyncActionDisabledReason ? 'quota-sync-action-hint' : undefined}
              title={quotaSyncButtonTitle}
              disabled={busy.settings || !appSettings.quota_snapshot_sync_enabled || quotaSyncBusy}
            >
              <RefreshCw className={`h-4 w-4 ${quotaSyncBusy ? 'animate-spin' : ''}`} />
              {quotaSyncButtonLabel}
            </button>
          </SettingsRow>
          <DisclosurePanel ariaLabel="跨设备同步：权限与数据边界" openSignal={syncSignal}>
            <p>第二层独立授权，默认关闭。只同步通过契约校验的额度窗口；不会上传 action、账户标签、Token、Cookie、session、status-line 输入或本地路径。</p>
            <p>关闭同步、退出账户或撤销本机 Provider 权限，只会停止这台设备，不会删除云端历史。云端按 Provider 独立保存，并以来源 observedAt 较新的可用快照为准。</p>
            <p>云端最多保留 8 个活跃来源，已删除的来源不占名额。关闭本机来源不会释放已保留的云端名额；容量满时不会自动删除历史，也不会只选前 8 个来源上传。</p>
          </DisclosurePanel>
          <DangerZone>
            <SettingsRow
              label="云端额度快照管理"
              hint="删除单个来源后，新的本机观测仍可同步；删除全部会关闭本机额度同步。全部删除包括其他设备留下的账户额度历史，无法撤销，不会删除本机用量账本。"
              icon={Trash2}
              danger
              wideControl
            >
              <div className="settings-inline-actions">
                {[
                  ['openai-codex-local', 'Codex'],
                  ['anthropic-claude-consumer', 'Claude'],
                  ['google-antigravity-consumer', 'Antigravity'],
                ].map(([providerId, displayName]) => {
                  const cloudDeleteBusy = quotaSnapshotProviderBusy(providerId);
                  return (
                    <button
                      key={providerId}
                      className="secondary-inline"
                      type="button"
                      disabled={busy.settings || !cloudStatus.authenticated || quotaSnapshotBusy}
                      onClick={(event: ReactMouseEvent<HTMLButtonElement>) => void runDeleteQuotaSnapshot(
                        providerId,
                        'consumer-subscription',
                        event.currentTarget,
                      )}
                      aria-label={cloudDeleteBusy ? `正在删除 ${displayName} 云端快照` : `删除 ${displayName} 云端快照`}
                      aria-busy={cloudDeleteBusy || undefined}
                      title={cloudDeleteBusy ? `正在删除 ${displayName} 云端快照` : `删除 ${displayName} 云端快照`}
                    >
                      {cloudDeleteBusy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                      {cloudDeleteBusy ? '删除中…' : `删除 ${displayName} 云端快照`}
                    </button>
                  );
                })}
                <button
                  className="danger-inline"
                  type="button"
                  disabled={busy.settings || !cloudStatus.authenticated || quotaSnapshotBusy}
                  onClick={(event: ReactMouseEvent<HTMLButtonElement>) => void runClearQuotaSnapshots(event.currentTarget)}
                  aria-label={quotaSnapshotAllBusy ? '正在删除全部云端额度' : '删除全部云端额度'}
                  aria-busy={quotaSnapshotAllBusy || undefined}
                  title={quotaSnapshotAllBusy ? '正在删除全部云端额度' : '删除全部云端额度'}
                >
                  {quotaSnapshotAllBusy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                  {quotaSnapshotAllBusy ? '删除中…' : '删除全部云端额度'}
                </button>
              </div>
            </SettingsRow>
          </DangerZone>
        </SettingsGroup>
      </SettingsCard>
    </SettingsSection>
  );
}

/** 与看板共用币种规则（契约 §2.2）：CNY/USD/EUR/GBP/JPY 用符号，其余照写 ISO 代码。 */
export function formatBalanceAmount(remaining: number, currency: string): string {
  return formatQuotaCurrencyAmount(remaining, currency);
}

export interface BalanceAmountView {
  windowId: string;
  currency: string;
  text: string;
}

export type BalanceCardState = 'off' | 'waiting' | 'connected' | 'key-required' | 'read-failed';

export interface BalanceCardView {
  state: BalanceCardState;
  label: string;
  sentence: string;
  detail?: string;
  amounts: BalanceAmountView[];
  asOf?: string;
}

export function balanceAmounts(provider: QuotaProviderEnvelope | undefined): BalanceAmountView[] {
  if (!provider || (provider.status !== 'ok' && provider.status !== 'stale')) return [];
  return provider.windows.flatMap((window) => {
    const { currency, remaining } = window;
    if (
      window.unit !== 'currency'
      || typeof currency !== 'string'
      || !/^[A-Z]{3}$/.test(currency)
      || typeof remaining !== 'number'
      || !Number.isFinite(remaining)
      || remaining < 0
    ) return [];
    return [{ windowId: window.windowId, currency, text: formatBalanceAmount(remaining, currency) }];
  });
}

const BALANCE_REASON_SENTENCES: Record<string, string> = {
  balance_unavailable: '余额接口没有返回可验证的余额数值或币种。',
  rate_limited: '请求过于频繁，稍后会自动重试。',
  upstream_unavailable: '供应商服务暂时不可用。',
  source_temporarily_unavailable: '供应商这次没有正常返回。',
  source_schema_unsupported: '余额响应格式不兼容或超过大小上限。',
  secure_storage_unavailable: '系统钥匙串暂时无法读取，解锁后点「刷新额度」。',
  provider_worker_failed: '余额读取进程暂时失败。',
};

export function balanceCardView({ enabled, provider, now }: {
  enabled: boolean;
  provider: QuotaProviderEnvelope | undefined;
  now: number;
}): BalanceCardView {
  if (!enabled) return { state: 'off', label: '未开启', sentence: '打开后读取这家的官方余额。', amounts: [] };
  if (!provider) return { state: 'waiting', label: '等待读取', sentence: '正在等待首次读取。', amounts: [] };
  const amounts = balanceAmounts(provider);
  const observedAt = latestObservedAt(provider);
  if (provider.status === 'ok' && amounts.length > 0) {
    const observedMs = observedAt ? new Date(observedAt).getTime() : Number.NaN;
    return {
      state: 'connected',
      label: Number.isFinite(observedMs) ? `已连接 · ${formatSourceRelative(observedMs, now)}` : '已连接',
      sentence: '余额来自供应商官方接口。',
      amounts,
    };
  }
  const reasonCode = provider.reasonCode;
  if (provider.status === 'auth-required' || reasonCode === 'api_key_required') {
    return {
      state: 'key-required',
      label: '需要 API key',
      sentence: '请在「供应商」页为它填写或更新 API key；OpenRouter 需要 Management key。',
      detail: reasonCode ? `供应商拒绝了当前 key，或还没有 key（${reasonCode}）` : undefined,
      amounts,
      asOf: amounts.length > 0 ? observedAt : undefined,
    };
  }
  const sentence = (reasonCode && BALANCE_REASON_SENTENCES[reasonCode]) || '这次没有读到余额。';
  return {
    state: 'read-failed',
    label: amounts.length > 0 ? '读取失败（保留旧值）' : '读取失败',
    sentence,
    detail: reasonCode ? `${sentence}（${reasonCode}）` : undefined,
    amounts,
    asOf: amounts.length > 0 ? observedAt : undefined,
  };
}

const BALANCE_STATE_TONES: Record<BalanceCardState, 'pending' | 'waiting' | 'ready' | 'blocked'> = {
  off: 'pending',
  waiting: 'waiting',
  connected: 'ready',
  'key-required': 'waiting',
  'read-failed': 'blocked',
};

const BALANCE_VENDOR_HINTS: Record<QuotaBalanceVendor, string> = {
  moonshot: '官方余额接口',
  deepseek: '官方余额接口',
  openrouter: '官方余额接口 · 需 Management key',
  siliconflow: '官方余额接口',
  relay: '没有已知的官方余额接口 · 中转站可填写同源余额地址',
};

type RelayDraft = QuotaRelayBalanceConfig;

function emptyRelayDraft(source: QuotaBalanceSourceView): RelayDraft {
  return source.relay ?? { balanceUrl: `https://${source.host}/`, valuePath: 'data.balance', currency: 'CNY' };
}

function BalanceSourceStatus({ name, view }: { name: string; view: BalanceCardView }) {
  return (
    <div className="quota-source-status" data-state={view.state}>
      <div className="quota-source-status-head">
        <span className={`settings-value quota-setup-stage quota-setup-stage-${BALANCE_STATE_TONES[view.state]}`} role="status">
          {view.label}
        </span>
        {view.asOf && <span className="quota-source-asof">截至 {formatSourceAsOf(view.asOf)}</span>}
      </div>
      <div className="quota-source-message">
        <p>
          {view.sentence}
          {view.detail && (
            <span className="quota-source-info" role="note" tabIndex={0} title={view.detail} aria-label={`${name} 详细原因：${view.detail}`}>
              <Info className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          )}
        </p>
      </div>
      {view.amounts.length > 0 && (
        <ul className="quota-source-windows" aria-label={`${name} 余额`}>
          {view.amounts.map((amount) => (
            <li key={amount.windowId} className="quota-source-window">
              <div className="quota-source-window-head">
                <span>余额（{amount.currency}）</span>
                <b>{amount.text}</b>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 供应商余额（REQ-QUOTA-10）：复用「供应商」页的 key，逐个开启，只显示余额数值与币种，不画进度。 */
export function QuotaBalanceCard({ quotaProviders, now, disabled, onChanged }: {
  quotaProviders: QuotaProviderEnvelope[];
  now: number;
  disabled: boolean;
  onChanged: () => void;
}) {
  const [sources, setSources] = useState<QuotaBalanceSourceView[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [relayEditingId, setRelayEditingId] = useState<string | null>(null);
  const [relayDraft, setRelayDraft] = useState<RelayDraft | null>(null);

  useEffect(() => {
    let active = true;
    invoke<QuotaBalanceSourceView[]>('list_quota_balance_sources')
      .then((next) => {
        if (active) setSources(next);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, []);

  const save = async (source: QuotaBalanceSourceView, enabled: boolean, relay?: RelayDraft) => {
    setBusyId(source.gatewayProviderId);
    setError('');
    try {
      const next = await invoke<QuotaBalanceSourceView[]>('set_quota_balance_source', {
        input: { gatewayProviderId: source.gatewayProviderId, enabled, ...(relay ? { relay } : {}) },
      });
      setSources(next);
      setRelayEditingId(null);
      setRelayDraft(null);
      onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusyId(null);
    }
  };

  const enabledCount = sources?.filter((source) => source.enabled).length ?? 0;

  return (
    <SettingsCard title="供应商余额" description="读取「供应商」页里已配置 key 的官方余额；只显示余额数值与币种，不换汇、不画进度。">
      <SettingsGroup>
        {sources !== null && sources.length === 0 && (
          <SettingsRow label="还没有供应商" hint="先在「供应商」页添加供应商并填入 API key。">
            <span className="settings-value">没有可读取余额的供应商</span>
          </SettingsRow>
        )}
        {(sources ?? []).map((source) => {
          const name = source.gatewayProviderName;
          const isRelay = source.vendor === 'relay';
          const view = balanceCardView({
            enabled: source.enabled,
            provider: quotaProviders.find((provider) => provider.providerId === source.providerId),
            now,
          });
          const busy = busyId === source.gatewayProviderId;
          const editing = relayEditingId === source.gatewayProviderId && relayDraft !== null;
          return (
            <div key={source.gatewayProviderId} className="quota-balance-source">
              <SettingsToggleRow
                label={`${name} 余额`}
                hint={`${source.host} · ${BALANCE_VENDOR_HINTS[source.vendor]}`}
                icon={Wallet}
                checked={source.enabled}
                disabled={disabled || busyId !== null || (isRelay && !source.relay && !source.enabled)}
                busy={busy}
                onChange={(checked) => void save(source, checked)}
              />
              {source.enabled && <BalanceSourceStatus name={name} view={view} />}
              {isRelay && !editing && (
                <SettingsRow
                  label="中转余额地址"
                  hint={source.relay ? `${source.relay.balanceUrl} · 取值 ${source.relay.valuePath} · ${source.relay.currency}` : '还没配置；必须与该中转站的接口地址同源。'}
                >
                  <button
                    className="secondary-inline"
                    type="button"
                    disabled={disabled || busyId !== null}
                    aria-label={`配置 ${name} 的中转余额地址`}
                    onClick={() => {
                      setRelayEditingId(source.gatewayProviderId);
                      setRelayDraft(emptyRelayDraft(source));
                    }}
                  >
                    {source.relay ? '修改' : '配置'}
                  </button>
                </SettingsRow>
              )}
              {isRelay && editing && relayDraft && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save(source, true, relayDraft);
                  }}
                >
                  <SettingsRow label="余额地址" hint={`只能是 ${source.host} 下的地址，不能带 query 或账号。`} wideControl>
                    <input
                      className="settings-input"
                      value={relayDraft.balanceUrl}
                      onChange={(event) => setRelayDraft({ ...relayDraft, balanceUrl: event.target.value })}
                      inputMode="url"
                      required
                      aria-label={`${name} 余额地址`}
                    />
                  </SettingsRow>
                  <SettingsRow label="取值路径" hint="响应 JSON 里余额字段的位置，用点分隔，例如 data.balance。" wideControl>
                    <input
                      className="settings-input"
                      value={relayDraft.valuePath}
                      onChange={(event) => setRelayDraft({ ...relayDraft, valuePath: event.target.value })}
                      required
                      aria-label={`${name} 取值路径`}
                    />
                  </SettingsRow>
                  <SettingsRow label="币种" hint="三个大写字母，例如 CNY、USD；不会从响应里猜。" wideControl busy={busy}>
                    <input
                      className="settings-input"
                      value={relayDraft.currency}
                      onChange={(event) => setRelayDraft({ ...relayDraft, currency: event.target.value.toUpperCase() })}
                      maxLength={3}
                      required
                      aria-label={`${name} 币种`}
                    />
                    <div className="settings-inline-actions">
                      <button className="secondary-inline" type="submit" disabled={disabled || busyId !== null} aria-busy={busy || undefined}>
                        {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                        {busy ? '保存中…' : '保存并开启'}
                      </button>
                      <button
                        className="secondary-inline"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setRelayEditingId(null);
                          setRelayDraft(null);
                        }}
                      >
                        取消
                      </button>
                    </div>
                  </SettingsRow>
                </form>
              )}
            </div>
          );
        })}
        {error && <p className="settings-error" role="alert">{error}</p>}
        <DisclosurePanel ariaLabel="供应商余额：权限与数据边界" openSignal={enabledCount}>
          <p>直接复用「供应商」页保存在系统钥匙串里的 key（同一条目，不另存一份），只发往该供应商官方文档里的余额地址；中转站只能请求它自己域名下、你显式填写的地址。</p>
          <p>禁止重定向和 URL 里的账号或 query，响应最多读取 256 KiB；遇到限流会退避，失败时保留上次的余额并标「截至」。</p>
          <p>开启跨设备同步后，只同步余额数值与币种，不同步 key、地址或原始响应；旧版客户端看不到余额。</p>
        </DisclosurePanel>
      </SettingsGroup>
    </SettingsCard>
  );
}

const EXPERIMENTAL_PLAN_REASON_SENTENCES: Record<string, string> = {
  experimental_consent_required: '风险提示有更新，重新确认后才会读取。',
  api_key_required: '请在「供应商」页为它填写或更新 API key。',
  secure_storage_unavailable: '系统钥匙串暂时无法读取，解锁后点「刷新额度」。',
  source_schema_unsupported: '接口返回的格式变了，暂时读不到。',
  rate_limited: '请求过于频繁，稍后会自动重试。',
  upstream_unavailable: '供应商服务暂时不可用。',
  source_temporarily_unavailable: '供应商这次没有正常返回。',
  provider_worker_failed: '读取进程暂时失败。',
};

/** 实验套餐的原因码文案（含 `experimental_consent_required`）；未登记的码统一回落为读取失败。 */
export function experimentalPlanReasonSentence(reasonCode: string | undefined): string {
  return (reasonCode && EXPERIMENTAL_PLAN_REASON_SENTENCES[reasonCode]) || '这次没有读到套餐用量。';
}

/** 状态卡复用订阅来源的五态外观；风险未确认、缺 key 与读取失败各给一句话。 */
export function experimentalPlanCardView({ plan, provider, now }: {
  plan: Pick<QuotaExperimentalPlanView, 'enabled' | 'consentCurrent'>;
  provider: QuotaProviderEnvelope | undefined;
  now: number;
}): QuotaSourceCardView {
  if (!plan.enabled) return { state: 'needs-authorization', label: '未开启', sentence: '开启前会先说明风险。', action: null, windows: [] };
  const reasonCode = provider?.reasonCode;
  if (!plan.consentCurrent || reasonCode === 'experimental_consent_required') {
    return { state: 'needs-authorization', label: '待确认风险', sentence: experimentalPlanReasonSentence('experimental_consent_required'), action: null, windows: [] };
  }
  if (!provider) return { state: 'needs-authorization', label: '等待读取', sentence: '正在等待首次读取。', action: null, windows: [] };
  const windows = sourceWindows(provider, now);
  const observedAt = latestObservedAt(provider);
  if (provider.status === 'ok' && windows.length > 0) {
    const observedMs = observedAt ? new Date(observedAt).getTime() : Number.NaN;
    return {
      state: 'connected',
      label: Number.isFinite(observedMs) ? `已连接 · ${formatSourceRelative(observedMs, now)}` : '已连接',
      sentence: '实验性接口，数值仅供参考。',
      action: null,
      windows,
    };
  }
  const sentence = experimentalPlanReasonSentence(reasonCode);
  const detail = reasonCode ? `${sentence}（${reasonCode}）` : undefined;
  if (provider.status === 'auth-required' || reasonCode === 'api_key_required') {
    return { state: 'login-required', label: '需要 API key', sentence, action: null, detail, windows, asOf: windows.length > 0 ? observedAt : undefined };
  }
  return {
    state: 'read-failed',
    label: windows.length > 0 ? '读取失败（保留旧值）' : '读取失败',
    sentence,
    action: null,
    detail,
    windows,
    asOf: windows.length > 0 ? observedAt : undefined,
  };
}

function ExperimentalPlanRiskDialog({ plan, busy, onCancel, onConfirm }: {
  plan: QuotaExperimentalPlanView;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      const dialog = dialogRef.current;
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled])'));
      if (focusable.length === 0) return;
      const wrapTarget = focusWrapTarget(
        event.shiftKey ? 'backward' : 'forward',
        document.activeElement === focusable[0],
        document.activeElement === focusable[focusable.length - 1],
      );
      if (wrapTarget === 'last') {
        event.preventDefault();
        focusable[focusable.length - 1].focus();
      } else if (wrapTarget === 'first') {
        event.preventDefault();
        focusable[0].focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      previous?.focus({ preventScroll: true });
    };
  }, []);

  const host = plan.host ?? '该供应商的官方域名';
  const dialog = (
    <div
      className="modal-overlay confirm-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <section
        ref={dialogRef}
        className="modal-content confirm-dialog confirm-dialog-primary"
        role="dialog"
        aria-modal="true"
        aria-labelledby="experimental-plan-risk-title"
        aria-describedby="experimental-plan-risk-body"
        tabIndex={-1}
      >
        <div className="confirm-dialog-icon" aria-hidden="true">
          <FlaskConical className="h-5 w-5" />
        </div>
        <div className="confirm-dialog-copy">
          <h2 id="experimental-plan-risk-title" className="confirm-dialog-title">开启{plan.displayName}？</h2>
          <div id="experimental-plan-risk-body">
            <p className="confirm-dialog-description">接口没有公开文档，可能随时变化或失效。</p>
            <p className="confirm-dialog-description">请求会用到你在「供应商」页保存的 API key，只发往 {host}。</p>
            <p className="confirm-dialog-description">不读取订阅登录、Cookie 或 OAuth，也不会替你消耗额度。</p>
          </div>
          <p className="confirm-dialog-description">风险提示第 {plan.riskVersion} 版；更新后需要重新确认。</p>
        </div>
        <footer className="confirm-dialog-actions">
          <button ref={cancelRef} className="ghost-inline" type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button className="primary-inline" type="button" onClick={onConfirm} disabled={busy} aria-busy={busy || undefined}>
            {busy ? '开启中…' : '确认风险并开启'}
          </button>
        </footer>
      </section>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(dialog, document.body) : dialog;
}

/** 实验性套餐用量（REQ-QUOTA-11）：收在「高级」里，默认关闭；未确认当前风险版本时后端不读 key、不发请求。 */
export function QuotaExperimentalPlansCard({ quotaProviders, now, disabled, onChanged }: {
  quotaProviders: QuotaProviderEnvelope[];
  now: number;
  disabled: boolean;
  onChanged: () => void;
}) {
  const [plans, setPlans] = useState<QuotaExperimentalPlanView[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [riskPlan, setRiskPlan] = useState<QuotaExperimentalPlanView | null>(null);

  useEffect(() => {
    let active = true;
    invoke<QuotaExperimentalPlanView[]>('list_quota_experimental_plans')
      .then((next) => {
        if (active) setPlans(next);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, []);

  const save = async (plan: QuotaExperimentalPlanView, enabled: boolean, acceptRiskVersion?: number) => {
    setBusyId(plan.providerId);
    setError('');
    try {
      const next = await invoke<QuotaExperimentalPlanView[]>('set_quota_experimental_plan', {
        input: { providerId: plan.providerId, enabled, ...(acceptRiskVersion !== undefined ? { acceptRiskVersion } : {}) },
      });
      setPlans(next);
      setRiskPlan(null);
      onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusyId(null);
    }
  };

  const enabledCount = plans?.filter((plan) => plan.enabled).length ?? 0;

  return (
    <SettingsCard title="编码套餐">
      <SettingsGroup>
        <DisclosurePanel title="高级" ariaLabel="编码套餐：高级" decorative openSignal={enabledCount}>
          <p>
            <span className="experimental-badge" style={{ marginRight: 6 }}>实验性</span>
            智谱 GLM、MiniMax、Kimi Code 的套餐用量，默认关闭。
          </p>
          {(plans ?? []).map((plan) => {
            const view = experimentalPlanCardView({
              plan,
              provider: quotaProviders.find((provider) => provider.providerId === plan.providerId),
              now,
            });
            const missingProvider = !plan.host;
            return (
              <div key={plan.providerId}>
                <SettingsToggleRow
                  label={plan.displayName}
                  hint={missingProvider ? '先在「供应商」页添加这家并填入 API key。' : `${plan.host} · 实验性`}
                  icon={FlaskConical}
                  checked={plan.enabled}
                  disabled={disabled || busyId !== null || (missingProvider && !plan.enabled)}
                  busy={busyId === plan.providerId}
                  onChange={(checked) => {
                    if (checked && !plan.consentCurrent) setRiskPlan(plan);
                    else void save(plan, checked);
                  }}
                />
                {plan.enabled && (
                  <QuotaSourceStatus
                    providerId={plan.providerId}
                    name={plan.displayName}
                    view={view}
                    readLabel=""
                    readBusyLabel=""
                    readBusy={false}
                    readDisabled
                  />
                )}
              </div>
            );
          })}
          {error && <p className="settings-error" role="alert">{error}</p>}
        </DisclosurePanel>
        <DisclosurePanel ariaLabel="编码套餐：权限与数据边界">
          <p>只用「供应商」页里这家的 API key（同一钥匙串条目），只发往它的固定域名；不读订阅登录、Cookie 或 OAuth，不预热窗口。</p>
          <p>结果只在本机显示，不进跨设备同步；读取失败时保留上次的值并标「截至」。</p>
        </DisclosurePanel>
      </SettingsGroup>
      {riskPlan && (
        <ExperimentalPlanRiskDialog
          plan={riskPlan}
          busy={busyId === riskPlan.providerId}
          onCancel={() => { if (busyId === null) setRiskPlan(null); }}
          onConfirm={() => void save(riskPlan, true, riskPlan.riskVersion)}
        />
      )}
    </SettingsCard>
  );
}

export default QuotaSection;
