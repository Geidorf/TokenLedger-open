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
import { localized, t, useLang, getLang, type MessageKey } from '../../i18n';

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

interface ReasonCopyKeys {
  sentence: MessageKey;
  action: QuotaSourceAction | null;
  detail: MessageKey;
}

const LOGIN_REASON_CODES = new Set([
  'app_server_auth_required',
  'claude_native_authorization_required',
  'antigravity_native_authorization_required',
]);

const SOURCE_REASON_COPY: Record<string, ReasonCopyKeys> = {
  app_server_auth_required: { sentence: 'qs.reason.appServerAuthRequired', action: null, detail: 'qs.reason.appServerAuthRequired.detail' },
  app_server_unavailable: { sentence: 'qs.reason.appServerUnavailable', action: null, detail: 'qs.reason.appServerUnavailable.detail' },
  app_server_timeout: { sentence: 'qs.reason.appServerTimeout', action: null, detail: 'qs.reason.appServerTimeout.detail' },
  claude_statusline_snapshot_missing: { sentence: 'qs.reason.claudeStatuslineSnapshotMissing', action: null, detail: 'qs.reason.claudeStatuslineSnapshotMissing.detail' },
  claude_statusline_snapshot_invalid: { sentence: 'qs.reason.claudeStatuslineSnapshotInvalid', action: null, detail: 'qs.reason.claudeStatuslineSnapshotInvalid.detail' },
  claude_native_authorization_required: { sentence: 'qs.reason.claudeNativeAuthorizationRequired', action: 'read', detail: 'qs.reason.claudeNativeAuthorizationRequired.detail' },
  claude_native_cli_unavailable: { sentence: 'qs.reason.claudeNativeCliUnavailable', action: 'install', detail: 'qs.reason.claudeNativeCliUnavailable.detail' },
  claude_native_timeout: { sentence: 'qs.reason.claudeNativeTimeout', action: 'read', detail: 'qs.reason.claudeNativeTimeout.detail' },
  claude_native_usage_unavailable: { sentence: 'qs.reason.claudeNativeUsageUnavailable', action: 'read', detail: 'qs.reason.claudeNativeUsageUnavailable.detail' },
  claude_native_subscription_unavailable: { sentence: 'qs.reason.claudeNativeSubscriptionUnavailable', action: null, detail: 'qs.reason.claudeNativeSubscriptionUnavailable.detail' },
  claude_native_response_invalid: { sentence: 'qs.reason.claudeNativeResponseInvalid', action: 'read', detail: 'qs.reason.claudeNativeResponseInvalid.detail' },
  claude_codexbar_unavailable: { sentence: 'qs.reason.claudeCodexbarUnavailable', action: 'read', detail: 'qs.reason.claudeCodexbarUnavailable.detail' },
  claude_codexbar_timeout: { sentence: 'qs.reason.claudeCodexbarTimeout', action: 'read', detail: 'qs.reason.claudeCodexbarTimeout.detail' },
  claude_codexbar_response_invalid: { sentence: 'qs.reason.claudeCodexbarResponseInvalid', action: 'read', detail: 'qs.reason.claudeCodexbarResponseInvalid.detail' },
  antigravity_native_authorization_required: { sentence: 'qs.reason.antigravityNativeAuthorizationRequired', action: 'read', detail: 'qs.reason.antigravityNativeAuthorizationRequired.detail' },
  antigravity_native_source_not_found: { sentence: 'qs.reason.antigravityNativeSourceNotFound', action: 'read', detail: 'qs.reason.antigravityNativeSourceNotFound.detail' },
  antigravity_native_port_unavailable: { sentence: 'qs.reason.antigravityNativePortUnavailable', action: 'read', detail: 'qs.reason.antigravityNativePortUnavailable.detail' },
  antigravity_native_timeout: { sentence: 'qs.reason.antigravityNativeTimeout', action: 'read', detail: 'qs.reason.antigravityNativeTimeout.detail' },
  antigravity_native_response_invalid: { sentence: 'qs.reason.antigravityNativeResponseInvalid', action: 'read', detail: 'qs.reason.antigravityNativeResponseInvalid.detail' },
  antigravity_codexbar_unavailable: { sentence: 'qs.reason.antigravityCodexbarUnavailable', action: 'read', detail: 'qs.reason.antigravityCodexbarUnavailable.detail' },
  antigravity_codexbar_timeout: { sentence: 'qs.reason.antigravityCodexbarTimeout', action: 'read', detail: 'qs.reason.antigravityCodexbarTimeout.detail' },
  antigravity_codexbar_response_invalid: { sentence: 'qs.reason.antigravityCodexbarResponseInvalid', action: 'read', detail: 'qs.reason.antigravityCodexbarResponseInvalid.detail' },
  permission_denied: { sentence: 'qs.reason.permissionDenied', action: null, detail: 'qs.reason.permissionDenied.detail' },
  source_not_found: { sentence: 'qs.reason.sourceNotFound', action: null, detail: 'qs.reason.sourceNotFound.detail' },
  observation_stale: { sentence: 'qs.reason.observationStale', action: 'read', detail: 'qs.reason.observationStale.detail' },
  reset_elapsed: { sentence: 'qs.reason.resetElapsed', action: 'read', detail: 'qs.reason.resetElapsed.detail' },
};

function sourceReasonCopy(reasonCode: string | undefined): ReasonCopy {
  const keys = reasonCode ? SOURCE_REASON_COPY[reasonCode] : undefined;
  if (!keys) return { sentence: t('qs.readFailedGeneric'), action: 'read', detail: '' };
  return { sentence: t(keys.sentence), action: keys.action, detail: t(keys.detail) };
}

function formatSourceRelative(observedAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - observedAt) / 60_000));
  if (minutes < 1) return t('qs.justNow');
  if (minutes < 60) return t('qs.ago.minutes', { n: minutes });
  if (minutes < 1_440) return t('qs.ago.hours', { n: Math.floor(minutes / 60) });
  return t('qs.ago.days', { n: Math.floor(minutes / 1_440) });
}

function formatSourceReset(resetsAt: string | undefined, now: number): string | null {
  if (!resetsAt) return null;
  const at = new Date(resetsAt).getTime();
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return t('qs.resetting');
  if (minutes < 120) return t('qs.resetIn.minutes', { n: minutes });
  if (minutes < 2_880) return t('qs.resetIn.hours', { n: Math.round(minutes / 60) });
  return t('qs.resetIn.days', { n: Math.round(minutes / 1_440) });
}

export function formatSourceAsOf(observedAt: string): string {
  const date = new Date(observedAt);
  if (Number.isNaN(date.getTime())) return observedAt;
  return new Intl.DateTimeFormat(getLang() === 'en' ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
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
      return { state: 'not-installed', label: t('qs.state.notInstalled'), sentence: t('qs.notInstalled', { name }), action: 'install', windows: [] };
    }
    return { state: 'needs-authorization', label: t('qs.state.needsAuth'), sentence: t('qs.offUntilEnabled'), action: null, windows: [] };
  }
  if (!provider) {
    return { state: 'needs-authorization', label: t('qs.state.needsAuth'), sentence: t('qs.waitingFirstRead'), action: null, windows: [] };
  }
  const windows = sourceWindows(provider, now);
  const observedAt = latestObservedAt(provider);
  const reasonCode = provider.reasonCode;
  const copy = sourceReasonCopy(reasonCode);
  const detail = reasonCode ? t('qs.detailWithCode', { detail: copy.detail || copy.sentence, code: reasonCode }) : undefined;
  if (provider.status === 'ok') {
    const observedMs = observedAt ? new Date(observedAt).getTime() : Number.NaN;
    return {
      state: 'connected',
      label: Number.isFinite(observedMs) ? t('qs.connectedAgo', { ago: formatSourceRelative(observedMs, now) }) : t('qs.connected'),
      sentence: windows.length > 0 ? t('qs.fromOfficialClient') : t('qs.connectedNoWindows'),
      action: 'read',
      windows,
    };
  }
  if ((reasonCode && LOGIN_REASON_CODES.has(reasonCode))
    || (provider.status === 'auth-required' && !reasonCode?.endsWith('_local_authorization_required'))) {
    return {
      state: 'login-required',
      label: t('qs.state.loginRequired'),
      sentence: copy.sentence,
      action: copy.action,
      detail,
      windows,
      asOf: windows.length > 0 ? observedAt : undefined,
    };
  }
  if (provider.status === 'auth-required') {
    return { state: 'needs-authorization', label: t('qs.state.needsAuth'), sentence: t('qs.authPending'), action: null, detail, windows: [] };
  }
  if (installed === false && windows.length === 0) {
    return { state: 'not-installed', label: t('qs.state.notInstalled'), sentence: t('qs.notInstalled', { name }), action: 'install', detail, windows: [] };
  }
  if (reasonCode === 'claude_statusline_snapshot_missing' && windows.length === 0) {
    return { state: 'needs-authorization', label: t('qs.state.needsAuth'), sentence: copy.sentence, action: null, detail, windows: [] };
  }
  return {
    state: 'read-failed',
    label: windows.length > 0 ? t('qs.state.readFailedKept') : t('qs.state.readFailed'),
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
        {view.asOf && <span className="quota-source-asof">{t('qs.asOf', { time: formatSourceAsOf(view.asOf) })}</span>}
      </div>
      <div className="quota-source-message">
        <p>
          {view.sentence}
          {view.detail && (
            <span className="quota-source-info" role="note" tabIndex={0} title={view.detail} aria-label={t('qs.detailAria', { name, detail: view.detail })}>
              <Info className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          )}
        </p>
        {view.action === 'install' && installUrl && (
          <a className="secondary-inline" href={installUrl} target="_blank" rel="noopener noreferrer" aria-label={t('qs.installAria', { name })}>
            {t('qs.installGuide')}
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
            {readBusy ? t('qs.reading') : t('qs.readNow')}
          </button>
        )}
      </div>
      {view.windows.length > 0 && (
        <ul className="quota-source-windows" aria-label={t('qs.windowsAria', { name })}>
          {view.windows.map((window) => (
            <li key={window.windowId} className="quota-source-window">
              <div className="quota-source-window-head">
                <span>{window.label}</span>
                <b>{t('qs.remaining', { pct: window.remaining })}</b>
              </div>
              <div
                className="quota-source-meter"
                data-level={quotaLevel(window.remaining)}
                role="progressbar"
                aria-label={t('qs.remainingAria', { name, window: window.label })}
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
          <h2 id="claude-setup-preview-title" className="confirm-dialog-title">{t('qs.claude.previewTitle')}</h2>
          <p className="confirm-dialog-description">
            {preview.fileExists ? preview.settingsPath : t('qs.newFile', { path: preview.settingsPath })}
          </p>
          {preview.changed ? (
            <pre className="settings-code settings-code-block" aria-label={t('qs.claude.previewAria')} tabIndex={0}>{preview.diff}</pre>
          ) : (
            <p className="confirm-dialog-description">{t('qs.claude.alreadyWired')}</p>
          )}
          <p className="confirm-dialog-description">
            {preview.keepsOriginal ? t('qs.claude.keepsOriginal') : t('qs.claude.backupFirst')}
          </p>
        </div>
        <footer className="confirm-dialog-actions">
          <button ref={cancelRef} className="ghost-inline" type="button" onClick={onCancel} disabled={busy}>
            {t('qs.cancel')}
          </button>
          <button
            className="primary-inline"
            type="button"
            onClick={onConfirm}
            disabled={busy || !preview.changed}
            aria-busy={busy || undefined}
          >
            {busy ? t('qs.writing') : t('qs.confirmWrite')}
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
    <SettingsCard title={t('qs.alerts.title')}>
      <SettingsGroup>
        <SettingsToggleRow
          label={t('qs.alerts.toggle')}
          hint={t('qs.alerts.toggleHint')}
          icon={Bell}
          checked={settings.enabled}
          disabled={disabled}
          busy={saving}
          onChange={(enabled) => void save({ ...settings, enabled })}
        />
        <SettingsRow label={t('qs.alerts.levels')} hint={t('qs.alerts.levelsHint')}>
          <div className="settings-inline-actions" role="group" aria-label={t('qs.alerts.levels')}>
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
                  title={onlySelected ? t('qs.alerts.keepOne') : undefined}
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
  useLang();
  const { appSettings, busy, cloudStatus, quotaSyncStatus } = props;
  const [claudeStatuslineCommand, setClaudeStatuslineCommand] = useState(t('qs.claude.readingPath'));
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
      case 'active': return quotaSyncStatus.lastSyncedAt ? t('qs.sync.synced') : t('qs.sync.waitingFirst');
      case 'syncing': return t('qs.sync.syncing');
      case 'paused': return t('qs.sync.paused');
      case 'auth-required': return t('qs.sync.authRequired');
      case 'unavailable': return t('qs.sync.unavailable');
      case 'error': return t('qs.sync.error');
      default: return t('qs.sync.off');
    }
  })();
  const quotaSyncBusy = quotaSyncStatus.state === 'syncing';
  const quotaSyncButtonLabel = quotaSyncBusy ? t('qs.sync.busy') : t('qs.sync.button');
  const quotaSyncButtonAriaLabel = quotaSyncBusy ? t('qs.sync.busyAria') : t('qs.sync.button');
  const quotaSyncActionDisabledReason = busy.settings
    ? t('qs.sync.savingWait')
    : quotaSyncBusy
      ? t('qs.sync.syncingWait')
      : !appSettings.quota_snapshot_sync_enabled
        ? cloudStatus.authenticated
          ? t('qs.sync.enableFirst')
          : t('qs.sync.signInFirst')
        : undefined;
  const quotaSyncButtonTitle = quotaSyncActionDisabledReason
    ? t('qs.sync.ariaWithReason', { label: quotaSyncButtonAriaLabel, reason: quotaSyncActionDisabledReason })
    : t('qs.sync.nowAria');
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
    ? { ...claudeBaseView, sentence: t('qs.claude.notWired') }
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
        if (active) setClaudeStatuslineCommand(t('qs.claude.pathUnreadable'));
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
      title: t('qs.custom.deleteTitle', { name: endpoint.displayName }),
      description: t('qs.custom.deleteBody'),
      confirmLabel: t('qs.custom.deleteConfirm'),
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
    ? customEditingId ? t('qs.custom.savingBusy') : t('qs.custom.addingBusy')
    : customEditingId ? t('qs.custom.saveRefresh') : t('qs.custom.addRefresh');
  const customEndpointSaveTitle = customEndpointSaveBusy
    ? t('qs.custom.pleaseWait', { label: customEndpointSaveLabel })
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
      setClaudeSetupNotice(t('qs.claude.written'));
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
          title: t('qs.claude.forceRestoreTitle'),
          description: t('qs.claude.forceRestoreBody'),
          confirmLabel: t('qs.claude.forceRestore'),
          tone: 'danger',
        }
      : {
          title: t('qs.claude.restoreTitle'),
          description: claudeBackup.originalExisted
            ? t('qs.claude.restoreBodyChained')
            : t('qs.claude.restoreBody'),
          confirmLabel: t('qs.claude.restore'),
        });
    if (!confirmed) return;
    setClaudeSetupAction('restore');
    setClaudeSetupError('');
    setClaudeSetupNotice('');
    try {
      await invoke('restore_claude_statusline_setup', { force });
      setClaudeSetupNotice(t('qs.claude.restored'));
    } catch (error) {
      setClaudeSetupError(String(error));
    } finally {
      setClaudeSetupAction(null);
      setClaudeSetupReloadKey((key) => key + 1);
    }
  };

  return (
    <SettingsSection id="quota" title={t('qs.title')}>
      <section className="quota-overview" aria-label={t('qs.overview.aria')}>
        <div className="quota-overview-head">
          <div>
            <span className="quota-overview-kicker">{t('qs.overview.kicker')}</span>
            <h3>{t('qs.overview.title')}</h3>
            <p>{t('qs.overview.body')}</p>
          </div>
          <span className={`quota-overview-badge${overview.localConnectedCount + overview.companyEnabledCount > 0 ? ' is-active' : ''}`}>
            {overview.localAttentionCount > 0
              ? t('qs.overview.needsAttention')
              : overview.localConnectedCount + overview.companyEnabledCount > 0 ? t('qs.overview.someConnected') : t('qs.overview.waiting')}
          </span>
        </div>
        <div className="quota-overview-grid">
          <div className="quota-overview-item">
            <span>{t('qs.overview.localConnected')}</span>
            <strong>{overview.localConnectedCount}/3</strong>
            <small>
              {overview.localEnabledCount > 0 ? t('qs.overview.enabledCount', { n: overview.localEnabledCount }) : t('qs.overview.notEnabled')}
              {overview.localAttentionCount > 0 ? t('qs.overview.attentionCount', { n: overview.localAttentionCount }) : ''}
            </small>
          </div>
          <div className="quota-overview-item">
            <span>{t('qs.company')}</span>
            <strong>{overview.companyConfiguredCount > 0 ? `${overview.companyEnabledCount}/${overview.companyConfiguredCount}` : '—'}</strong>
            <small>{overview.companyConfiguredCount > 0 ? t('qs.overview.companyCount', { configured: overview.companyConfiguredCount, enabled: overview.companyEnabledCount }) : t('qs.overview.noCompany')}</small>
          </div>
          <div className="quota-overview-item">
            <span>{t('qs.sync.title')}</span>
            <strong>{overview.syncLabel}</strong>
            <small>{t('qs.overview.syncNote')}</small>
          </div>
        </div>
      </section>
      <SettingsCard title="Codex">
        <QuotaSourceStatus
          providerId="openai-codex-local"
          name="Codex"
          view={codexView}
          readLabel={t('qs.codex.readNow')}
          readBusyLabel={t('qs.codex.readBusy')}
          readBusy={false}
          readDisabled
        />
        <SettingsGroup>
          <SettingsToggleRow
            label={t('qs.codex.toggle')}
            hint={t('qs.codex.toggleHint')}
            icon={Gauge}
            checked={appSettings.quota_codex_local_enabled}
            disabled={busy.settings || (codexInstalled === false && !appSettings.quota_codex_local_enabled)}
            busy={busy.settings}
            onChange={(checked) => props.onSettingChange('quota_codex_local_enabled', checked)}
          />
          <DisclosurePanel ariaLabel={t('qs.codex.boundary')} openSignal={codexSignal}>
            <p>{t('qs.codex.boundary1')}</p>
            <p>{t('qs.codex.boundary2')}</p>
          </DisclosurePanel>
        </SettingsGroup>
      </SettingsCard>

      <SettingsCard title="Claude">
        <QuotaSourceStatus
          providerId="anthropic-claude-consumer"
          name="Claude"
          view={claudeView}
          readLabel={t('qs.claude.readNow')}
          readBusyLabel={t('qs.claude.readBusy')}
          readBusy={claudeReadBusy}
          readDisabled={busy.settings}
          onRead={appSettings.quota_claude_codexbar_enabled
            ? () => { setClaudeSetupReloadKey((key) => key + 1); runQuotaRead('claude'); }
            : undefined}
        />
        <SettingsGroup>
          <SettingsToggleRow
            label={t('qs.claude.toggle')}
            hint={t('qs.claude.toggleHint')}
            icon={Gauge}
            checked={appSettings.quota_claude_enabled}
            disabled={busy.settings || (claudeInstalled === false && !appSettings.quota_claude_enabled)}
            busy={busy.settings}
            onChange={(checked) => props.onSettingChange('quota_claude_enabled', checked)}
          />
          <SettingsRow
            label={t('qs.claude.setup')}
            hint={claudeSetupNotice || (claudeSetup?.statusLineWired
              ? claudeSetup.chainPresent ? t('qs.claude.chainKept') : t('qs.claude.wired')
              : appSettings.quota_claude_enabled
                ? t('qs.claude.previewFirst')
                : t('qs.claude.turnOnFirst'))}
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
                  {claudeSetupAction === 'preview' ? t('qs.reading') : t('qs.claude.setup')}
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
                  {claudeSetupAction === 'restore' ? t('qs.claude.restoring') : t('qs.claude.restoreOriginal')}
                </button>
              )}
            </div>
          </SettingsRow>
          {claudeSetupError && <p className="settings-error" role="alert">{claudeSetupError}</p>}
          <DisclosurePanel title={t('qs.claude.manual')} ariaLabel={t('qs.claude.manualAria')} decorative>
            <p>
              {claudeSetup?.settingsPath
                ? t('qs.claude.manualMergeInto', { path: claudeSetup.settingsPath })
                : t('qs.claude.manualMerge')}
            </p>
            <pre className="settings-code settings-code-block" aria-label={t('qs.claude.configAria')}>{claudeStatuslineBlock || claudeStatuslineCommand}</pre>
            <button
              className="secondary-inline"
              type="button"
              onClick={copyClaudeStatuslineCommand}
              disabled={!claudeStatuslineReady}
            >
              {statuslineCopyState === 'copied' ? t('qs.copied') : statuslineCopyState === 'manual' ? t('qs.copyManually') : t('qs.copyAll')}
            </button>
          </DisclosurePanel>
          <DisclosurePanel title={t('qs.advanced')} ariaLabel={t('qs.claude.advancedAria')} decorative>
            <SettingsToggleRow
              label={t('qs.claude.experimental')}
              hint={t('qs.claude.experimentalHint')}
              icon={FlaskConical}
              checked={appSettings.quota_claude_codexbar_enabled}
              disabled={busy.settings || !appSettings.quota_claude_enabled}
              busy={busy.settings}
              onChange={props.onClaudeNativeQuotaChange}
            />
            {appSettings.quota_claude_codexbar_enabled && (
              <SettingsRow label={t('qs.claude.probe')} hint={t('qs.claude.probeHint')} wideControl>
                {claudeSetup && claudeSetup.cliCandidates.length === 0 ? (
                  <span className="settings-value quota-setup-stage quota-setup-stage-blocked">
                    {t('qs.claude.noCli')}
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
          <DisclosurePanel ariaLabel={t('qs.claude.boundary')} openSignal={claudeSignal}>
            <p>{t('qs.claude.boundary1')}</p>
            <p>{t('qs.claude.boundary2')}</p>
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
          readLabel={t('qs.antigravity.readNow')}
          readBusyLabel={t('qs.antigravity.readBusy')}
          readBusy={antigravityReadBusy}
          readDisabled={busy.settings}
          onRead={appSettings.quota_antigravity_local_enabled ? () => runQuotaRead('antigravity') : undefined}
        />
        <SettingsGroup>
          <SettingsToggleRow
            label={t('qs.antigravity.toggle')}
            hint={t('qs.antigravity.toggleHint')}
            icon={Gauge}
            checked={appSettings.quota_antigravity_local_enabled}
            disabled={busy.settings || (antigravityInstalled === false && !appSettings.quota_antigravity_local_enabled)}
            busy={busy.settings}
            onChange={props.onAntigravityLocalQuotaChange}
          />
          <DisclosurePanel title={t('qs.advanced')} ariaLabel={t('qs.antigravity.advancedAria')} decorative>
            <SettingsToggleRow
              label={t('qs.antigravity.codexbar')}
              hint={t('qs.antigravity.codexbarHint')}
              icon={FlaskConical}
              checked={appSettings.quota_antigravity_codexbar_enabled}
              disabled={busy.settings || !appSettings.quota_antigravity_local_enabled}
              busy={busy.settings}
              onChange={(checked) => props.onSettingChange('quota_antigravity_codexbar_enabled', checked)}
            />
          </DisclosurePanel>
          <DisclosurePanel ariaLabel={t('qs.antigravity.boundary')} openSignal={antigravitySignal}>
            <p>{t('qs.antigravity.boundary1')}</p>
            <p>{t('qs.antigravity.boundary2')}</p>
          </DisclosurePanel>
        </SettingsGroup>
      </SettingsCard>
      <QuotaExperimentalPlansCard
        quotaProviders={props.quotaProviders}
        now={now}
        disabled={busy.settings}
        onChanged={props.onCustomQuotaChanged}
      />
      <SettingsCard title={t('qs.company')}>
        <SettingsGroup>
          {customEndpoints.length === 0 && (
            <SettingsRow label={t('qs.custom.empty')} hint={t('qs.custom.emptyHint')}>
              <span className="settings-value">{t('qs.custom.none')}</span>
            </SettingsRow>
          )}
          {customEndpoints.map((endpoint) => {
            const toggleBusy = customEndpointActionBusy('toggle', endpoint.id);
            const deleteBusy = customEndpointActionBusy('delete', endpoint.id);
            const cloudDeleteBusy = quotaSnapshotProviderBusy(endpoint.providerId);
            const toggleLabel = endpoint.enabled ? t('qs.custom.disable') : t('qs.custom.enable');
            const toggleBusyLabel = endpoint.enabled ? t('qs.custom.disabling') : t('qs.custom.enabling');
            const apiKeyLabel = endpoint.hasApiKey === true
              ? t('qs.custom.keySaved')
              : endpoint.hasApiKey === false
                ? t('qs.custom.keyMissing')
                : t('qs.custom.keyUnchecked');
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
                  {endpoint.enabled ? t('qs.custom.enabled') : t('qs.custom.disabled')} · {apiKeyLabel} · {endpoint.schemaVerified ? t('qs.custom.schemaVerified') : t('qs.custom.schemaUnverified')}
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
                  {toggleBusy ? t('qs.working') : toggleLabel}
                </button>
                <button
                  className="secondary-inline"
                  type="button"
                  disabled={customEndpointBusy || busy.settings}
                  onClick={() => editCustomEndpoint(endpoint)}
                  aria-label={t('qs.custom.editAria', { name: endpoint.displayName })}
                  title={t('qs.custom.editAria', { name: endpoint.displayName })}
                >
                  {t('qs.edit')}
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
                  aria-label={t(cloudDeleteBusy ? 'qs.cloudDelete.busyAria' : 'qs.cloudDelete.aria', { name: endpoint.displayName })}
                  aria-busy={cloudDeleteBusy || undefined}
                  title={t(cloudDeleteBusy ? 'qs.cloudDelete.busyAria' : 'qs.cloudDelete.aria', { name: endpoint.displayName })}
                >
                  {cloudDeleteBusy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                  {cloudDeleteBusy ? t('qs.deleting') : t('qs.cloudDelete.button')}
                </button>
                <button
                  className="danger-inline"
                  type="button"
                  disabled={customEndpointBusy || busy.settings}
                  onClick={() => void deleteCustomEndpoint(endpoint)}
                  aria-label={t(deleteBusy ? 'qs.localDelete.busyAria' : 'qs.localDelete.aria', { name: endpoint.displayName })}
                  aria-busy={deleteBusy || undefined}
                  title={t(deleteBusy ? 'qs.localDelete.busyAria' : 'qs.localDelete.aria', { name: endpoint.displayName })}
                >
                  {deleteBusy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                  {deleteBusy ? t('qs.deleting') : t('qs.localDelete.button')}
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
                hint={t('qs.orphan.hint')}
                icon={Cloud}
                wideControl
              >
                <div className="settings-inline-actions">
                  <span className="settings-value">{t('qs.orphan.cloudHistory')}</span>
                  <button
                    className="danger-inline"
                    type="button"
                    disabled={customEndpointBusy || busy.settings || !cloudStatus.authenticated || quotaSnapshotBusy}
                    onClick={(event: ReactMouseEvent<HTMLButtonElement>) => void runDeleteQuotaSnapshot(
                      provider.providerId,
                      'api-organization',
                      event.currentTarget,
                    )}
                    aria-label={t(cloudDeleteBusy ? 'qs.cloudDelete.busyAria' : 'qs.cloudDelete.aria', { name: provider.displayName })}
                    aria-busy={cloudDeleteBusy || undefined}
                    title={t(cloudDeleteBusy ? 'qs.cloudDelete.busyAria' : 'qs.cloudDelete.aria', { name: provider.displayName })}
                  >
                    {cloudDeleteBusy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                    {cloudDeleteBusy ? t('qs.deleting') : t('qs.orphan.delete')}
                  </button>
                </div>
              </SettingsRow>
            );
          })}

          <form onSubmit={saveCustomEndpoint}>
            <SettingsRow
              label={customEditingId ? t('qs.custom.editTitle') : t('qs.custom.addTitle')}
              hint={t('qs.custom.nameHint')}
              icon={Plus}
              wideControl
              busy={customEndpointSaveBusy}
            >
              <input
                className="settings-input"
                value={customName}
                onChange={(event) => setCustomName(event.target.value)}
                placeholder={t('qs.custom.namePlaceholder')}
                maxLength={40}
                required
                aria-label={t('qs.custom.nameAria')}
              />
            </SettingsRow>
            <SettingsRow label={t('qs.custom.url')} hint={t('qs.custom.urlHint')} wideControl>
              <input
                className="settings-input"
                value={customUrl}
                onChange={(event) => setCustomUrl(event.target.value)}
                placeholder="https://your-gateway.example.com/v1/me/quota"
                inputMode="url"
                required
                aria-label={t('qs.custom.urlAria')}
              />
            </SettingsRow>
            <SettingsRow
              label="API key"
              hint={customEditingId ? t('qs.custom.keyKeepHint') : t('qs.custom.keyStoreHint')}
              wideControl
            >
              <input
                className="settings-input"
                type="password"
                value={customApiKey}
                onChange={(event) => setCustomApiKey(event.target.value)}
                placeholder={customEditingId ? t('qs.custom.keyKeepPlaceholder') : t('qs.custom.keyPlaceholder')}
                autoComplete="new-password"
                required={!customEditingId}
                aria-label={t('qs.custom.keyAria')}
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
                  {customEndpointSaveBusy ? t('qs.saving') : customEditingId ? t('qs.custom.saveRefresh') : t('qs.custom.addRefresh')}
                </button>
                {customEditingId && (
                  <button className="secondary-inline" type="button" disabled={customEndpointBusy} onClick={resetCustomEditor}>
                    {t('qs.custom.cancelEdit')}
                  </button>
                )}
              </div>
            </SettingsRow>
          </form>
          {customEndpointError && <p className="settings-error" role="alert">{customEndpointError}</p>}
          <DisclosurePanel ariaLabel={t('qs.custom.boundary')} openSignal={customEndpoints.length + orphanedCustomProviders.length}>
            <p>{t('qs.custom.boundary1')}</p>
            <p>{t('qs.custom.boundary2')}</p>
            <p>{t('qs.custom.boundary3a')}<code>Authorization: Bearer</code>{t('qs.custom.boundary3b')}</p>
            <p>{t('qs.custom.boundary4')}</p>
            <p>{t('qs.custom.boundary5')}</p>
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

      <SettingsCard title={t('qs.sync.title')}>
        <SettingsGroup>
          <SettingsToggleRow
            label={t('qs.sync.toggle')}
            hint={t('qs.sync.toggleHint')}
            icon={Cloud}
            checked={appSettings.quota_snapshot_sync_enabled}
            disabled={busy.settings || (!appSettings.quota_snapshot_sync_enabled && !cloudStatus.authenticated)}
            busy={busy.settings}
            onChange={props.onQuotaSyncToggle}
          />
          <SettingsRow label={t('qs.sync.status')} hint={t('qs.sync.statusHint')} busy={quotaSyncBusy} wideControl={Boolean(quotaSyncRecoveryMessage)}>
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
          <DisclosurePanel ariaLabel={t('qs.sync.boundary')} openSignal={syncSignal}>
            <p>{t('qs.sync.boundary1')}</p>
            <p>{t('qs.sync.boundary2')}</p>
            <p>{t('qs.sync.boundary3')}</p>
          </DisclosurePanel>
          <DangerZone>
            <SettingsRow
              label={t('qs.snapshots.title')}
              hint={t('qs.snapshots.hint')}
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
                      aria-label={t(cloudDeleteBusy ? 'qs.cloudDelete.busyAria' : 'qs.cloudDelete.aria', { name: displayName })}
                      aria-busy={cloudDeleteBusy || undefined}
                      title={t(cloudDeleteBusy ? 'qs.cloudDelete.busyAria' : 'qs.cloudDelete.aria', { name: displayName })}
                    >
                      {cloudDeleteBusy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                      {cloudDeleteBusy ? t('qs.deleting') : t('qs.cloudDelete.aria', { name: displayName })}
                    </button>
                  );
                })}
                <button
                  className="danger-inline"
                  type="button"
                  disabled={busy.settings || !cloudStatus.authenticated || quotaSnapshotBusy}
                  onClick={(event: ReactMouseEvent<HTMLButtonElement>) => void runClearQuotaSnapshots(event.currentTarget)}
                  aria-label={quotaSnapshotAllBusy ? t('qs.snapshots.deletingAll') : t('qs.snapshots.deleteAll')}
                  aria-busy={quotaSnapshotAllBusy || undefined}
                  title={quotaSnapshotAllBusy ? t('qs.snapshots.deletingAll') : t('qs.snapshots.deleteAll')}
                >
                  {quotaSnapshotAllBusy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                  {quotaSnapshotAllBusy ? t('qs.deleting') : t('qs.snapshots.deleteAll')}
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

const BALANCE_REASON_SENTENCES = localized<string>({
  balance_unavailable: 'qs.msg.balanceUnavailable',
  rate_limited: 'qs.msg.rateLimited',
  upstream_unavailable: 'qs.msg.upstreamUnavailable',
  source_temporarily_unavailable: 'qs.msg.sourceTemporarilyUnavailable',
  source_schema_unsupported: 'qs.msg.balanceSchemaUnsupported',
  secure_storage_unavailable: 'qs.msg.secureStorageUnavailable',
  provider_worker_failed: 'qs.msg.balanceWorkerFailed',
});

export function balanceCardView({ enabled, provider, now }: {
  enabled: boolean;
  provider: QuotaProviderEnvelope | undefined;
  now: number;
}): BalanceCardView {
  if (!enabled) return { state: 'off', label: t('qs.balance.off'), sentence: t('qs.balance.offSentence'), amounts: [] };
  if (!provider) return { state: 'waiting', label: t('qs.balance.waiting'), sentence: t('qs.waitingFirstRead'), amounts: [] };
  const amounts = balanceAmounts(provider);
  const observedAt = latestObservedAt(provider);
  if (provider.status === 'ok' && amounts.length > 0) {
    const observedMs = observedAt ? new Date(observedAt).getTime() : Number.NaN;
    return {
      state: 'connected',
      label: Number.isFinite(observedMs) ? t('qs.connectedAgo', { ago: formatSourceRelative(observedMs, now) }) : t('qs.connected'),
      sentence: t('qs.balance.fromOfficial'),
      amounts,
    };
  }
  const reasonCode = provider.reasonCode;
  if (provider.status === 'auth-required' || reasonCode === 'api_key_required') {
    return {
      state: 'key-required',
      label: t('qs.balance.needsKey'),
      sentence: t('qs.balance.needsKeySentence'),
      detail: reasonCode ? t('qs.balance.keyRejected', { code: reasonCode }) : undefined,
      amounts,
      asOf: amounts.length > 0 ? observedAt : undefined,
    };
  }
  const sentence = (reasonCode && BALANCE_REASON_SENTENCES[reasonCode]) || t('qs.balance.readFailedGeneric');
  return {
    state: 'read-failed',
    label: amounts.length > 0 ? t('qs.state.readFailedKept') : t('qs.state.readFailed'),
    sentence,
    detail: reasonCode ? t('qs.detailWithCode', { detail: sentence, code: reasonCode }) : undefined,
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

const BALANCE_VENDOR_HINTS = localized<QuotaBalanceVendor>({
  moonshot: 'qs.vendor.official',
  deepseek: 'qs.vendor.official',
  openrouter: 'qs.vendor.openrouter',
  siliconflow: 'qs.vendor.official',
  relay: 'qs.vendor.relay',
});

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
        {view.asOf && <span className="quota-source-asof">{t('qs.asOf', { time: formatSourceAsOf(view.asOf) })}</span>}
      </div>
      <div className="quota-source-message">
        <p>
          {view.sentence}
          {view.detail && (
            <span className="quota-source-info" role="note" tabIndex={0} title={view.detail} aria-label={t('qs.detailAria', { name, detail: view.detail })}>
              <Info className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          )}
        </p>
      </div>
      {view.amounts.length > 0 && (
        <ul className="quota-source-windows" aria-label={t('qs.balance.ofName', { name })}>
          {view.amounts.map((amount) => (
            <li key={amount.windowId} className="quota-source-window">
              <div className="quota-source-window-head">
                <span>{t('qs.balance.amount', { currency: amount.currency })}</span>
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
  useLang();
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
    <SettingsCard title={t('qs.balance.title')} description={t('qs.balance.description')}>
      <SettingsGroup>
        {sources !== null && sources.length === 0 && (
          <SettingsRow label={t('qs.balance.noProviders')} hint={t('qs.balance.noProvidersHint')}>
            <span className="settings-value">{t('qs.balance.noReadable')}</span>
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
                label={t('qs.balance.ofName', { name })}
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
                  label={t('qs.relay.title')}
                  hint={source.relay ? t('qs.relay.summary', { url: source.relay.balanceUrl, path: source.relay.valuePath, currency: source.relay.currency }) : t('qs.relay.notConfigured')}
                >
                  <button
                    className="secondary-inline"
                    type="button"
                    disabled={disabled || busyId !== null}
                    aria-label={t('qs.relay.configureAria', { name })}
                    onClick={() => {
                      setRelayEditingId(source.gatewayProviderId);
                      setRelayDraft(emptyRelayDraft(source));
                    }}
                  >
                    {source.relay ? t('qs.relay.change') : t('qs.relay.configure')}
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
                  <SettingsRow label={t('qs.relay.url')} hint={t('qs.relay.urlHint', { host: source.host })} wideControl>
                    <input
                      className="settings-input"
                      value={relayDraft.balanceUrl}
                      onChange={(event) => setRelayDraft({ ...relayDraft, balanceUrl: event.target.value })}
                      inputMode="url"
                      required
                      aria-label={t('qs.relay.urlAria', { name })}
                    />
                  </SettingsRow>
                  <SettingsRow label={t('qs.relay.path')} hint={t('qs.relay.pathHint')} wideControl>
                    <input
                      className="settings-input"
                      value={relayDraft.valuePath}
                      onChange={(event) => setRelayDraft({ ...relayDraft, valuePath: event.target.value })}
                      required
                      aria-label={t('qs.relay.pathAria', { name })}
                    />
                  </SettingsRow>
                  <SettingsRow label={t('qs.relay.currency')} hint={t('qs.relay.currencyHint')} wideControl busy={busy}>
                    <input
                      className="settings-input"
                      value={relayDraft.currency}
                      onChange={(event) => setRelayDraft({ ...relayDraft, currency: event.target.value.toUpperCase() })}
                      maxLength={3}
                      required
                      aria-label={t('qs.relay.currencyAria', { name })}
                    />
                    <div className="settings-inline-actions">
                      <button className="secondary-inline" type="submit" disabled={disabled || busyId !== null} aria-busy={busy || undefined}>
                        {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                        {busy ? t('qs.saving') : t('qs.relay.saveEnable')}
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
                        {t('qs.cancel')}
                      </button>
                    </div>
                  </SettingsRow>
                </form>
              )}
            </div>
          );
        })}
        {error && <p className="settings-error" role="alert">{error}</p>}
        <DisclosurePanel ariaLabel={t('qs.balance.boundary')} openSignal={enabledCount}>
          <p>{t('qs.balance.boundary1')}</p>
          <p>{t('qs.balance.boundary2')}</p>
          <p>{t('qs.balance.boundary3')}</p>
        </DisclosurePanel>
      </SettingsGroup>
    </SettingsCard>
  );
}

const EXPERIMENTAL_PLAN_REASON_SENTENCES = localized<string>({
  experimental_consent_required: 'qs.msg.consentRequired',
  api_key_required: 'qs.msg.apiKeyRequired',
  secure_storage_unavailable: 'qs.msg.secureStorageUnavailable',
  source_schema_unsupported: 'qs.msg.planSchemaUnsupported',
  rate_limited: 'qs.msg.rateLimited',
  upstream_unavailable: 'qs.msg.upstreamUnavailable',
  source_temporarily_unavailable: 'qs.msg.sourceTemporarilyUnavailable',
  provider_worker_failed: 'qs.msg.planWorkerFailed',
});

/** 实验套餐的原因码文案（含 `experimental_consent_required`）；未登记的码统一回落为读取失败。 */
export function experimentalPlanReasonSentence(reasonCode: string | undefined): string {
  return (reasonCode && EXPERIMENTAL_PLAN_REASON_SENTENCES[reasonCode]) || t('qs.plan.readFailedGeneric');
}

/** 状态卡复用订阅来源的五态外观；风险未确认、缺 key 与读取失败各给一句话。 */
export function experimentalPlanCardView({ plan, provider, now }: {
  plan: Pick<QuotaExperimentalPlanView, 'enabled' | 'consentCurrent'>;
  provider: QuotaProviderEnvelope | undefined;
  now: number;
}): QuotaSourceCardView {
  if (!plan.enabled) return { state: 'needs-authorization', label: t('qs.balance.off'), sentence: t('qs.plan.offSentence'), action: null, windows: [] };
  const reasonCode = provider?.reasonCode;
  if (!plan.consentCurrent || reasonCode === 'experimental_consent_required') {
    return { state: 'needs-authorization', label: t('qs.plan.confirmRisk'), sentence: experimentalPlanReasonSentence('experimental_consent_required'), action: null, windows: [] };
  }
  if (!provider) return { state: 'needs-authorization', label: t('qs.balance.waiting'), sentence: t('qs.waitingFirstRead'), action: null, windows: [] };
  const windows = sourceWindows(provider, now);
  const observedAt = latestObservedAt(provider);
  if (provider.status === 'ok' && windows.length > 0) {
    const observedMs = observedAt ? new Date(observedAt).getTime() : Number.NaN;
    return {
      state: 'connected',
      label: Number.isFinite(observedMs) ? t('qs.connectedAgo', { ago: formatSourceRelative(observedMs, now) }) : t('qs.connected'),
      sentence: t('qs.plan.experimentalNote'),
      action: null,
      windows,
    };
  }
  const sentence = experimentalPlanReasonSentence(reasonCode);
  const detail = reasonCode ? t('qs.detailWithCode', { detail: sentence, code: reasonCode }) : undefined;
  if (provider.status === 'auth-required' || reasonCode === 'api_key_required') {
    return { state: 'login-required', label: t('qs.balance.needsKey'), sentence, action: null, detail, windows, asOf: windows.length > 0 ? observedAt : undefined };
  }
  return {
    state: 'read-failed',
    label: windows.length > 0 ? t('qs.state.readFailedKept') : t('qs.state.readFailed'),
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

  const host = plan.host ?? t('qs.plan.officialHost');
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
          <h2 id="experimental-plan-risk-title" className="confirm-dialog-title">{t('qs.plan.riskTitle', { name: plan.displayName })}</h2>
          <div id="experimental-plan-risk-body">
            <p className="confirm-dialog-description">{t('qs.plan.riskUndocumented')}</p>
            <p className="confirm-dialog-description">{t('qs.plan.riskKey', { host })}</p>
            <p className="confirm-dialog-description">{t('qs.plan.riskNoLogin')}</p>
          </div>
          <p className="confirm-dialog-description">{t('qs.plan.riskVersion', { version: plan.riskVersion })}</p>
        </div>
        <footer className="confirm-dialog-actions">
          <button ref={cancelRef} className="ghost-inline" type="button" onClick={onCancel} disabled={busy}>
            {t('qs.cancel')}
          </button>
          <button className="primary-inline" type="button" onClick={onConfirm} disabled={busy} aria-busy={busy || undefined}>
            {busy ? t('qs.plan.enabling') : t('qs.plan.confirmEnable')}
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
  useLang();
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
    <SettingsCard title={t('qs.plan.title')}>
      <SettingsGroup>
        <DisclosurePanel title={t('qs.advanced')} ariaLabel={t('qs.plan.advancedAria')} decorative openSignal={enabledCount}>
          <p>
            <span className="experimental-badge" style={{ marginRight: 6 }}>{t('qs.plan.experimental')}</span>
            {t('qs.plan.intro')}
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
                  hint={missingProvider ? t('qs.plan.missingProvider') : t('qs.plan.hostExperimental', { host: plan.host ?? '' })}
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
        <DisclosurePanel ariaLabel={t('qs.plan.boundary')}>
          <p>{t('qs.plan.boundary1')}</p>
          <p>{t('qs.plan.boundary2')}</p>
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
