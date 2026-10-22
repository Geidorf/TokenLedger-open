import type {
  QuotaAction,
  QuotaProviderEnvelope,
  QuotaSyncStatus,
  QuotaWindowSnapshot,
} from '../../types';
import { isRecord } from './internal';

type QuotaValueFields = Pick<
  QuotaWindowSnapshot,
  'unit' | 'used' | 'limit' | 'remaining' | 'reasonCode'
> & Partial<Pick<QuotaWindowSnapshot, 'currency' | 'windowMinutes' | 'resetsAt'>>;

type QuotaTimelineFields = Pick<
  QuotaWindowSnapshot,
  'observedAt' | 'fetchedAt' | 'resetsAt' | 'staleAfterSeconds' | 'windowMinutes'
>;

export type ValidatedQuotaWindowValues =
  | { kind: 'percent'; used: number; limit: 100; remaining: number }
  | {
    kind: 'absolute';
    used: number | undefined;
    limit: number | undefined;
    remaining: number | undefined;
  }
  | { kind: 'unlimited' };

function quotaValuesApproximatelyEqual(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Number.EPSILON * scale * 16;
}

const RFC3339_WITH_TIMEZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/i;

function parseQuotaTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = RFC3339_WITH_TIMEZONE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const utcDesignator = match[8].toUpperCase() === 'Z';
  const offsetHour = utcDesignator ? 0 : Number(match[9]);
  const offsetMinute = utcDesignator ? 0 : Number(match[10]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    return null;
  }
  // Normalize syntax and sub-millisecond precision before Date.parse so V8
  // and the JavaScriptCore family used by macOS WKWebView agree on RFC 3339.
  const fraction = match[7]
    ? `.${match[7].slice(0, 3).padEnd(3, '0')}`
    : '';
  const timezone = utcDesignator ? 'Z' : match[8];
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${fraction}${timezone}`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function validateQuotaWindowTimeline(window: QuotaTimelineFields): boolean {
  const observedAt = parseQuotaTimestamp(window.observedAt);
  const fetchedAt = parseQuotaTimestamp(window.fetchedAt);
  if (
    observedAt === null
    || fetchedAt === null
    || typeof window.staleAfterSeconds !== 'number'
    || !Number.isFinite(window.staleAfterSeconds)
    || !Number.isInteger(window.staleAfterSeconds)
    || window.staleAfterSeconds <= 0
    || window.staleAfterSeconds > 2_147_483_647
  ) {
    return false;
  }
  if (
    window.resetsAt !== undefined
    && parseQuotaTimestamp(window.resetsAt) === null
  ) {
    return false;
  }
  return window.windowMinutes === undefined || (
    typeof window.windowMinutes === 'number'
    && Number.isFinite(window.windowMinutes)
    && Number.isInteger(window.windowMinutes)
    && window.windowMinutes > 0
    && window.windowMinutes <= 2_147_483_647
  );
}

const QUOTA_SYNC_STATES = new Set([
  'disabled', 'active', 'syncing', 'paused', 'auth-required', 'unavailable', 'error',
]);

export function parseQuotaSyncStatus(value: unknown): QuotaSyncStatus {
  if (
    !isRecord(value)
    || typeof value.enabled !== 'boolean'
    || typeof value.state !== 'string'
    || !QUOTA_SYNC_STATES.has(value.state)
    || (value.lastSyncedAt !== undefined && (
      typeof value.lastSyncedAt !== 'string'
      || parseQuotaTimestamp(value.lastSyncedAt) === null
    ))
    || (value.reasonCode !== undefined && typeof value.reasonCode !== 'string')
  ) {
    throw new Error('额度同步状态契约无效');
  }
  if (
    (value.enabled && value.state === 'disabled')
    || (!value.enabled && (value.state === 'active' || value.state === 'syncing'))
  ) {
    throw new Error('额度同步状态契约无效');
  }
  return value as unknown as QuotaSyncStatus;
}

export interface QuotaSyncNowFeedback {
  type: 'success' | 'info' | 'error';
  message: string;
}

export function quotaSyncCapacityMessage(status: QuotaSyncStatus): string | undefined {
  if (status.reasonCode === 'quota_sync_invalid_provider_count') {
    return '本机待同步的活跃来源超过 8 个；跨设备额度同步最多支持 8 个活跃来源。请在额度设置中关闭部分本机来源后重试，已保留的云端来源不会被删除';
  }
  if (status.reasonCode === 'quota_sync_capacity_exceeded') {
    return '本次同步会使云端活跃来源超过 8 个上限，本次新增来源未同步；关闭本机来源不会删除云端历史或释放名额。请先查看下方云端快照管理的删除范围与代价';
  }
  return undefined;
}

export function quotaClearFeedback(status: QuotaSyncStatus): QuotaSyncNowFeedback {
  if (!status.enabled && status.state === 'disabled' && status.reasonCode === undefined) {
    return {
      type: 'success',
      message: '已删除全部云端额度快照，本机额度同步已关闭；如需继续同步，请重新开启它',
    };
  }
  if (status.reasonCode === 'quota_sync_clear_outcome_unknown_local_stop_incomplete') {
    return {
      type: 'error',
      message: '云端删除结果尚未确认，本机关闭同步也未确认。请求可能已生效，不代表已撤销；请先关闭本机同步并查看最新状态，再决定是否重新确认删除全部快照',
    };
  }
  if (status.reasonCode === 'quota_sync_clear_outcome_unknown') {
    return {
      type: 'error',
      message: '本机额度同步已关闭，但云端删除结果尚未确认；请求可能已在云端生效，不代表已撤销。请先查看最新状态，再决定是否重新确认删除全部快照；如需恢复同步，须手动重新启用',
    };
  }
  if (status.reasonCode === 'quota_sync_remote_clear_incomplete') {
    return {
      type: 'error',
      message: '删除结果尚未确认，请求可能已在云端生效，不代表已撤销。请先查看最新同步状态；若仍需清空，请重新确认删除全部快照的范围与代价',
    };
  }
  if (status.reasonCode === 'quota_sync_clear_local_stop_incomplete') {
    return {
      type: 'error',
      message: '云端已确认删除，但本机关闭同步未确认。请先关闭本机同步并查看最新状态，不要因这个错误重复删除云端快照',
    };
  }
  if (status.reasonCode === 'quota_sync_clear_busy') {
    return {
      type: 'error',
      message: '另一项额度操作正在进行，本次清空尚未发送；请稍后重新确认删除全部快照的范围与代价',
    };
  }
  if (status.reasonCode === 'quota_sync_clear_rejected_device_stopped') {
    return {
      type: 'error',
      message: '本次删除请求被拒绝，不能视为删除完成；本机额度同步已关闭，不会自动恢复。请查看最新状态并处理拒绝原因；如需恢复同步，须手动重新启用',
    };
  }
  if (status.reasonCode === 'quota_sync_clear_dispatch_stop_incomplete') {
    return {
      type: 'error',
      message: '清空前关闭本机同步未完成，本次云端删除尚未发送。请先确认本机同步已关闭，再重新确认删除全部快照的范围与代价',
    };
  }
  return {
    type: 'error',
    message: '未确认完成删除全部云端快照，不能视为已完成。请先查看最新同步状态，处理登录或连接问题后再决定是否重试',
  };
}

export function quotaClearErrorFeedback(error: unknown): QuotaSyncNowFeedback {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  const reasonCode = /^(?:Error: )?(quota_sync_clear_outcome_unknown_local_stop_incomplete|quota_sync_clear_outcome_unknown|quota_sync_clear_local_stop_incomplete|quota_sync_clear_busy|quota_sync_clear_rejected_device_stopped|quota_sync_clear_dispatch_stop_incomplete)(?::|$)/.exec(message)?.[1];
  // Only known safe reason tokens affect copy; never display raw server errors.
  return quotaClearFeedback({ enabled: false, state: 'error', reasonCode });
}

/**
 * A completed IPC call is not necessarily a completed upload. The backend
 * deliberately returns fail-closed statuses for disabled, blocked and
 * cleanup-pending states, so only an unqualified active status may be
 * presented as a successful synchronization.
 */
export function quotaSyncNowFeedback(status: QuotaSyncStatus): QuotaSyncNowFeedback {
  if (status.state === 'active' && status.reasonCode === undefined) {
    return { type: 'success', message: '额度快照已同步' };
  }
  const capacityMessage = quotaSyncCapacityMessage(status);
  if (capacityMessage) return { type: 'error', message: capacityMessage };
  if (status.reasonCode === 'quota_sync_remote_clear_incomplete') {
    return {
      type: 'error',
      message: '远端清理尚未确认，当前未执行新的额度同步',
    };
  }
  if (status.state === 'paused') {
    return { type: 'info', message: '云端授权代次已变化，请重新显式启用额度同步' };
  }
  if (status.state === 'disabled') {
    return { type: 'info', message: '跨设备额度同步已关闭，当前未执行上传' };
  }
  if (status.state === 'auth-required') {
    return { type: 'info', message: '请先登录云端账户，再重新显式启用额度同步' };
  }
  if (status.state === 'syncing') {
    return { type: 'info', message: '额度同步仍在处理，请稍后查看最新状态' };
  }
  return { type: 'error', message: '本次额度同步未完成，请根据当前状态重试' };
}

export function quotaStatusAllowsValues(status: QuotaWindowSnapshot['status']): boolean {
  return status === 'ok' || status === 'stale';
}

const QUOTA_SCOPES = new Set(['consumer-subscription', 'api-organization', 'manual-budget']);
const QUOTA_MODES = new Set(['automatic', 'manual', 'unsupported']);
const QUOTA_CAPABILITIES = new Set(['stable', 'plan-dependent', 'experimental', 'manual', 'unsupported']);
const QUOTA_PROVIDER_STATUSES = new Set(['ok', 'stale', 'unsupported', 'auth-required', 'error']);
const QUOTA_WINDOW_STATUSES = new Set(['ok', 'stale', 'auth-required', 'error']);
const QUOTA_SOURCES = new Set(['official-api', 'local-authorized', 'manual']);
const QUOTA_UNITS = new Set(['percent', 'requests', 'tokens', 'usd', 'credits', 'currency']);
const ISO_4217_ALPHA = /^[A-Z]{3}$/;

/**
 * Newer providers may add units this build does not know. Such windows are
 * dropped one by one; the envelope survives only while a known window can
 * still back its status (ok -> stale when only stale windows remain).
 * Returns null when the whole envelope must be dropped.
 */
const DROPPED_PROVIDER = Symbol('dropped-provider');

function pruneUnknownUnitWindows(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.windows)) return value;
  const windows = value.windows.filter((window) => !(
    isRecord(window) && typeof window.unit === 'string' && !QUOTA_UNITS.has(window.unit)
  ));
  if (windows.length === value.windows.length) return value;
  if (windows.length === 0) return DROPPED_PROVIDER;
  const hasStatus = (status: string) => windows.some((window) => isRecord(window) && window.status === status);
  if (value.status === 'ok' && hasStatus('ok')) return { ...value, windows };
  if ((value.status === 'ok' || value.status === 'stale') && hasStatus('stale')) {
    return { ...value, status: 'stale', windows };
  }
  return DROPPED_PROVIDER;
}

export function validateQuotaProviderEnvelopeStructure(
  value: unknown,
): boolean {
  if (!isRecord(value)) return false;
  const provider = value;
  if (
    provider.schemaVersion !== 1
    || typeof provider.providerId !== 'string'
    || provider.providerId.length === 0
    || typeof provider.displayName !== 'string'
    || provider.displayName.length === 0
    || typeof provider.scope !== 'string'
    || !QUOTA_SCOPES.has(provider.scope)
    || typeof provider.mode !== 'string'
    || !QUOTA_MODES.has(provider.mode)
    || typeof provider.capability !== 'string'
    || !QUOTA_CAPABILITIES.has(provider.capability)
    || typeof provider.status !== 'string'
    || !QUOTA_PROVIDER_STATUSES.has(provider.status)
    || (provider.reasonCode !== undefined && typeof provider.reasonCode !== 'string')
    || !Array.isArray(provider.windows)
  ) {
    return false;
  }
  if (provider.status === 'unsupported') {
    return provider.mode === 'unsupported'
      && provider.capability === 'unsupported'
      && typeof provider.reasonCode === 'string'
      && provider.reasonCode.length > 0
      && provider.windows.length === 0;
  }
  if (provider.mode === 'unsupported' || provider.capability === 'unsupported') return false;
  const manualEnvelope = provider.mode === 'manual';
  if (
    manualEnvelope !== (provider.capability === 'manual')
    || manualEnvelope !== (provider.scope === 'manual-budget')
  ) {
    return false;
  }
  if (provider.status === 'auth-required' || provider.status === 'error') {
    return provider.windows.length === 0;
  }
  if (provider.windows.length === 0) return false;
  const windowIds = new Set<string>();
  let hasFreshWindow = false;
  let hasStaleWindow = false;
  const windowsValid = provider.windows.every((window) => {
    if (
      !isRecord(window)
      || typeof window.providerId !== 'string'
      || typeof window.windowId !== 'string'
      || window.windowId.length === 0
      || windowIds.has(window.windowId)
      || typeof window.windowLabel !== 'string'
      || window.windowLabel.length === 0
      || (window.accountLabel !== undefined && typeof window.accountLabel !== 'string')
      || typeof window.scope !== 'string'
      || !QUOTA_SCOPES.has(window.scope)
      || typeof window.source !== 'string'
      || !QUOTA_SOURCES.has(window.source)
      || typeof window.status !== 'string'
      || !QUOTA_WINDOW_STATUSES.has(window.status)
      || typeof window.unit !== 'string'
      || !QUOTA_UNITS.has(window.unit)
      || (window.currency !== undefined && typeof window.currency !== 'string')
      || typeof window.observedAt !== 'string'
      || typeof window.fetchedAt !== 'string'
      || typeof window.staleAfterSeconds !== 'number'
      || (window.resetsAt !== undefined && typeof window.resetsAt !== 'string')
      || (window.reasonCode !== undefined && typeof window.reasonCode !== 'string')
    ) {
      return false;
    }
    windowIds.add(window.windowId);
    hasFreshWindow ||= window.status === 'ok';
    hasStaleWindow ||= window.status === 'stale';
    return window.providerId === provider.providerId
      && window.scope === provider.scope
      && manualEnvelope === (window.source === 'manual');
  });
  if (!windowsValid) return false;
  return provider.status === 'ok' ? hasFreshWindow : hasStaleWindow;
}

/**
 * Decode the untrusted IPC boundary before React iterates provider fields.
 * Individual value/timeline semantics remain window-level fail-closed checks.
 */
export function parseQuotaProviderEnvelopes(value: unknown): QuotaProviderEnvelope[] {
  if (!Array.isArray(value)) {
    throw new Error('额度 Provider 契约无效');
  }
  const providerKeys = new Set<string>();
  const providers: unknown[] = [];
  for (const raw of value) {
    const provider = pruneUnknownUnitWindows(raw);
    if (provider === DROPPED_PROVIDER) continue;
    if (!validateQuotaProviderEnvelopeStructure(provider)) {
      throw new Error('额度 Provider 契约无效');
    }
    const record = provider as Record<string, unknown>;
    const stableKey = `${record.providerId}:${record.scope}`;
    if (providerKeys.has(stableKey)) throw new Error('额度 Provider 稳定键重复');
    providerKeys.add(stableKey);
    providers.push(provider);
  }
  return providers as QuotaProviderEnvelope[];
}

const QUOTA_SETTINGS_TARGETS: Readonly<Record<string, readonly string[]>> = {
  'openai-codex-local': ['codex-local'],
  'anthropic-claude-consumer': ['claude-local', 'claude-statusline'],
  'google-antigravity-consumer': ['antigravity-local'],
};

// No provider currently needs an external URL action. Keep the registry empty
// until a reviewed HTTPS origin + path is added here; arbitrary upstream URLs
// must fail closed instead of reaching window.open.
const QUOTA_URL_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {};

export function validateQuotaAction(
  providerId: unknown,
  action: unknown,
): QuotaAction | null {
  if (
    typeof providerId !== 'string'
    || !isRecord(action)
    || typeof action.kind !== 'string'
    || typeof action.labelKey !== 'string'
    || !/^quota\.action\.[A-Za-z0-9]+$/.test(action.labelKey)
    || typeof action.value !== 'string'
  ) {
    return null;
  }
  if (action.kind === 'open-settings') {
    return QUOTA_SETTINGS_TARGETS[providerId]?.includes(action.value) === true
      ? action as unknown as QuotaAction
      : null;
  }
  if (action.kind === 'show-command') {
    return providerId === 'anthropic-claude-consumer' && action.value === '/usage'
      ? action as unknown as QuotaAction
      : null;
  }
  if (action.kind !== 'open-url') return null;

  try {
    const url = new URL(action.value);
    const allowedPrefixes = QUOTA_URL_ALLOWLIST[providerId] || [];
    const canonical = `${url.origin}${url.pathname}`;
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.search
      || url.hash
      || !allowedPrefixes.some((prefix) => canonical === prefix || canonical.startsWith(`${prefix}/`))
    ) {
      return null;
    }
    return action as unknown as QuotaAction;
  } catch {
    return null;
  }
}

/**
 * Validate quota values before they reach presentation code. Invalid or empty
 * windows return null so the UI cannot turn malformed values into trusted
 * progress or absolute usage.
 */
export function validateQuotaWindowValues(window: QuotaValueFields): ValidatedQuotaWindowValues | null {
  if (!QUOTA_UNITS.has(window.unit)) return null;
  if (window.unit === 'currency') {
    if (
      typeof window.currency !== 'string'
      || !ISO_4217_ALPHA.test(window.currency)
      || window.windowMinutes !== undefined
      || window.resetsAt !== undefined
      || window.reasonCode === 'credits_unlimited'
    ) {
      return null;
    }
  } else if (window.currency !== undefined) {
    return null;
  }
  const numericValues = [window.used, window.limit, window.remaining];
  if (numericValues.some((value) => (
    value !== undefined
    && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
  ))) {
    return null;
  }

  const used = window.used;
  const limit = window.limit;
  const remaining = window.remaining;

  if (window.reasonCode === 'credits_unlimited') {
    return window.unit === 'credits'
      && used === undefined
      && limit === undefined
      && remaining === undefined
      ? { kind: 'unlimited' }
      : null;
  }

  if (window.unit === 'percent') {
    if (
      used === undefined
      || used > 100
      || (limit !== undefined && limit !== 100)
      || (remaining !== undefined && (
        remaining > 100
        || !quotaValuesApproximatelyEqual(remaining, 100 - used)
      ))
    ) {
      return null;
    }
    return { kind: 'percent', used, limit: 100, remaining: remaining ?? 100 - used };
  }

  if (used === undefined && limit === undefined && remaining === undefined) return null;
  if (
    (used !== undefined && limit !== undefined && used > limit)
    || (limit !== undefined && remaining !== undefined && remaining > limit)
    || (
      used !== undefined
      && limit !== undefined
      && remaining !== undefined
      && !quotaValuesApproximatelyEqual(remaining, limit - used)
    )
  ) {
    return null;
  }

  return { kind: 'absolute', used, limit, remaining };
}

export function quotaPercent(window: QuotaValueFields): number | null {
  const values = validateQuotaWindowValues(window);
  return values?.kind === 'percent' ? values.used : null;
}

export function focusWrapTarget(
  direction: 'forward' | 'backward',
  activeAtFirst: boolean,
  activeAtLast: boolean,
): 'first' | 'last' | null {
  if (direction === 'backward' && activeAtFirst) return 'last';
  if (direction === 'forward' && activeAtLast) return 'first';
  return null;
}

export function shouldRefreshVisibleQuotas(
  visibilityState: DocumentVisibilityState,
  lastRequestedAt: number,
  now: number,
  intervalMs = 5 * 60_000,
): boolean {
  if (visibilityState !== 'visible') return false;
  if (
    !Number.isFinite(lastRequestedAt)
    || !Number.isFinite(now)
    || !Number.isFinite(intervalMs)
    || intervalMs <= 0
    || lastRequestedAt <= 0
  ) {
    return true;
  }
  const elapsed = now - lastRequestedAt;
  return elapsed < 0 || elapsed >= intervalMs;
}
