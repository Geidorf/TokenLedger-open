import { ChevronDown, Command, Gauge, Globe2, LoaderCircle, Network, RefreshCw, Settings2, Sparkles, Terminal } from 'lucide-react';
import { EmptyState } from './EmptyState';
import { useEffect, useId, useState } from 'react';
import type { QuotaProviderEnvelope, QuotaSyncStatus, QuotaWindowSnapshot } from '../types';
import { effectiveVisibleQuotaSourceKeys } from '../utils/useDashboardDisplayPreferences';
import {
  quotaStatusAllowsValues,
  validateQuotaAction,
  validateQuotaProviderEnvelopeStructure,
  validateQuotaWindowTimeline,
  validateQuotaWindowValues,
} from '../utils/frontendContracts';
import { providerDisplayName, quotaLevel } from '../utils/quotaOverview';
import { computeQuotaPace, describeQuotaPace, type QuotaPace, type QuotaPaceCopy } from '../utils/quotaPace';
import { BrandIcon, resolveBrandIconKey } from './brand/BrandIcon';
import { format, getLang, localized, t, useLang, type MessageKey } from '../i18n';
import { FALLBACK_CLI_NAME } from './settings/QuotaSection';

interface QuotaPanelProps {
  providers: QuotaProviderEnvelope[];
  loading: boolean;
  error: string;
  /** The dashboard owns the primary recovery actions; the panel can keep context-only status. */
  showRecoveryActions?: boolean;
  quotaSyncStatus: QuotaSyncStatus;
  onRefresh: () => void;
  onSyncNow: () => void;
  onOpenSettings: () => void;
  onNotify: (message: string) => void;
  sourceOrder?: string[];
  hiddenSourceIds?: string[];
}

const REASON_LABELS: Record<string, string> = localized({
  local_authorization_required: 'quota.reason.localAuthorizationRequired',
  claude_local_authorization_required: 'quota.reason.claudeLocalAuthorizationRequired',
  claude_statusline_snapshot_missing: 'quota.reason.claudeStatuslineSnapshotMissing',
  claude_statusline_snapshot_invalid: 'quota.reason.claudeStatuslineSnapshotInvalid',
  claude_native_authorization_required: 'quota.reason.claudeNativeAuthorizationRequired',
  claude_native_cli_unavailable: 'quota.reason.claudeNativeCliUnavailable',
  claude_native_timeout: 'quota.reason.claudeNativeTimeout',
  claude_native_usage_unavailable: 'quota.reason.claudeNativeUsageUnavailable',
  claude_native_subscription_unavailable: 'quota.reason.claudeNativeSubscriptionUnavailable',
  claude_native_response_invalid: 'quota.reason.claudeNativeResponseInvalid',
  claude_codexbar_unavailable: 'quota.reason.claudeFallbackCliUnavailable',
  claude_codexbar_timeout: 'quota.reason.claudeFallbackCliTimeout',
  claude_codexbar_response_invalid: 'quota.reason.claudeFallbackCliResponseInvalid',
  antigravity_local_authorization_required: 'quota.reason.antigravityLocalAuthorizationRequired',
  antigravity_native_authorization_required: 'quota.reason.antigravityNativeAuthorizationRequired',
  antigravity_native_source_not_found: 'quota.reason.antigravityNativeSourceNotFound',
  antigravity_native_port_unavailable: 'quota.reason.antigravityNativePortUnavailable',
  antigravity_native_timeout: 'quota.reason.antigravityNativeTimeout',
  antigravity_native_response_invalid: 'quota.reason.antigravityNativeResponseInvalid',
  antigravity_codexbar_unavailable: 'quota.reason.antigravityFallbackCliUnavailable',
  antigravity_codexbar_timeout: 'quota.reason.antigravityFallbackCliTimeout',
  antigravity_codexbar_response_invalid: 'quota.reason.antigravityFallbackCliResponseInvalid',
  consumer_api_unavailable: 'quota.reason.consumerApiUnavailable',
  source_not_found: 'quota.reason.sourceNotFound',
  app_server_unavailable: 'quota.reason.appServerUnavailable',
  app_server_timeout: 'quota.reason.appServerTimeout',
  app_server_auth_required: 'quota.reason.appServerAuthRequired',
  permission_denied: 'quota.reason.permissionDenied',
  secure_storage_unavailable: 'quota.reason.secureStorageUnavailable',
  source_schema_unsupported: 'quota.reason.sourceSchemaUnsupported',
  source_scan_truncated: 'quota.reason.sourceScanTruncated',
  source_temporarily_unavailable: 'quota.reason.sourceTemporarilyUnavailable',
  observation_stale: 'quota.reason.observationStale',
  reset_elapsed: 'quota.reason.resetElapsed',
  provider_worker_failed: 'quota.reason.providerWorkerFailed',
  provider_cache_unavailable: 'quota.reason.providerCacheUnavailable',
  credits_unlimited: 'quota.reason.creditsUnlimited',
  admin_key_required: 'quota.reason.adminKeyRequired',
  api_key_required: 'quota.reason.apiKeyRequired',
  rate_limited: 'quota.reason.rateLimited',
  upstream_unavailable: 'quota.reason.upstreamUnavailable',
  balance_unavailable: 'quota.reason.balanceUnavailable',
  experimental_consent_required: 'quota.reason.experimentalConsentRequired',
});

const QUOTA_CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: 'JP¥',
};

const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(['JPY']);

/** quota-provider-v1 §2.2：五种常见币种用符号，其余照写 ISO 代码；JPY 取整，其余两位小数，不换汇、不合计。Android 同规则。 */
export function formatQuotaCurrencyAmount(amount: number, currency: string): string {
  const digits = ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
  const text = amount.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const symbol = QUOTA_CURRENCY_SYMBOLS[currency];
  return symbol ? `${symbol}${text}` : `${text} ${currency}`;
}

const COMPANY_QUOTA_PROVIDER_PREFIX = 'company-openapi-';
const COMPANY_QUOTA_WINDOW_LABELS = new Map<string, MessageKey>([
  ['user-daily', 'quota.company.daily'],
  ['user-monthly', 'quota.company.monthly'],
]);

export function isCompanyQuotaProvider(providerId: string): boolean {
  return providerId.startsWith(COMPANY_QUOTA_PROVIDER_PREFIX);
}

export function companyQuotaWindowLabel(windowId: string): string | null {
  const key = COMPANY_QUOTA_WINDOW_LABELS.get(windowId);
  return key ? t(key) : null;
}

export function selectCompanyQuotaWindows(windows: readonly QuotaWindowSnapshot[]): QuotaWindowSnapshot[] {
  return windows
    .filter((window) => COMPANY_QUOTA_WINDOW_LABELS.has(window.windowId))
    .sort((left, right) => (
      [...COMPANY_QUOTA_WINDOW_LABELS.keys()].indexOf(left.windowId)
      - [...COMPANY_QUOTA_WINDOW_LABELS.keys()].indexOf(right.windowId)
    ));
}

export function quotaProviderHasRenderableWindows(provider: QuotaProviderEnvelope): boolean {
  if (!validateQuotaProviderEnvelopeStructure(provider)) return false;
  if (provider.status !== 'ok' && provider.status !== 'stale') return false;
  return isCompanyQuotaProvider(provider.providerId)
    ? selectCompanyQuotaWindows(provider.windows).length > 0
    : provider.windows.length > 0;
}

function quotaWindowKind(windowId: string): string {
  const parts = windowId.split(':');
  return parts[parts.length - 1].replace(/^codexbar-/, '').toLowerCase();
}

function localizedQuotaDuration(minutes: number): string {
  if (minutes === 7 * 24 * 60) return t('quota.window.weekly');
  if (minutes === 24 * 60) return t('quota.window.daily');
  if (minutes % (24 * 60) === 0) return t('quota.window.days', { n: minutes / (24 * 60) });
  if (minutes % 60 === 0) return t('quota.window.hours', { n: minutes / 60 });
  return t('quota.window.minutes', { n: minutes });
}

const GENERIC_QUOTA_WINDOW_LABELS = new Set([
  'primary', 'primary window', 'secondary', 'secondary window', 'tertiary', 'tertiary window',
  '5-hour', '5-hour window', '5 hour', '5 hour window',
  '7-day', '7-day window', '7 day', '7 day window', 'weekly', 'weekly window',
  'credits', 'credits balance', 'included credits',
  '5 小时窗口', '7 天窗口', '周窗口', '主要窗口', '次要窗口', '附加窗口',
]);

const REDUNDANT_PROVIDER_PREFIXES: Record<string, Set<string>> = {
  'openai-codex-local': new Set(['codex', 'openai', 'openai codex']),
  'anthropic-claude-consumer': new Set(['claude', 'anthropic', 'anthropic claude']),
  'google-antigravity-consumer': new Set(['antigravity', 'google antigravity']),
};

function compactQuotaPrefix(label: string, providerId: string | undefined): string {
  const compact = label
    .trim()
    .replace(/(?:\s+|-)(?:weekly|week|daily|day|5[\s-]*hour|7[\s-]*day|每周额度|每日额度|5\s*小时额度|7\s*天额度)$/i, '')
    .trim();
  const normalized = compact.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  return providerId && REDUNDANT_PROVIDER_PREFIXES[providerId]?.has(normalized) ? '' : compact;
}

export function quotaWindowDisplayLabel(
  window: Pick<QuotaWindowSnapshot, 'windowId' | 'windowLabel' | 'windowMinutes' | 'unit' | 'reasonCode'>
    & Partial<Pick<QuotaWindowSnapshot, 'providerId'>>,
): string {
  const kind = quotaWindowKind(window.windowId);
  const credits = window.unit === 'credits' || window.reasonCode === 'credits_unlimited' || kind.includes('credits');
  const semanticLabel = credits
    ? t('quota.window.credits')
    : window.windowMinutes !== undefined
      ? localizedQuotaDuration(window.windowMinutes)
      : kind === 'five-hour'
        ? t('quota.window.fiveHour')
        : kind === 'seven-day' || kind === 'weekly'
          ? t('quota.window.weekly')
          : kind === 'primary'
            ? t('quota.window.primary')
            : kind === 'secondary'
              ? t('quota.window.secondary')
              : kind === 'tertiary'
                ? t('quota.window.tertiary')
                : null;
  if (!semanticLabel) return window.windowLabel;
  const separator = window.windowLabel.lastIndexOf('·');
  const explicitPrefix = separator > 0 ? window.windowLabel.slice(0, separator).trim() : '';
  const rawLabel = window.windowLabel.trim();
  // A bare duration is already a complete semantic label. Stripping "-day"
  // first would turn "7-day" into a spurious account prefix of "7".
  const normalizedRawLabel = rawLabel.toLowerCase().replace(/\s+/g, ' ');
  if (normalizedRawLabel === semanticLabel.toLowerCase() || GENERIC_QUOTA_WINDOW_LABELS.has(normalizedRawLabel)) {
    return semanticLabel;
  }
  const compactInferredPrefix = compactQuotaPrefix(rawLabel, window.providerId);
  const inferredPrefix = separator <= 0 && compactInferredPrefix !== rawLabel ? compactInferredPrefix : '';
  const prefix = compactQuotaPrefix(explicitPrefix || inferredPrefix, window.providerId);
  if (prefix) return `${prefix} · ${semanticLabel}`;
  if (explicitPrefix) return semanticLabel;
  return `${rawLabel} · ${semanticLabel}`;
}

export function quotaReasonLabel(reasonCode: string | undefined, fallback: string) {
  return reasonCode && REASON_LABELS[reasonCode] ? format(REASON_LABELS[reasonCode], { cli: FALLBACK_CLI_NAME }) : fallback;
}

function providerEmptyActionLabel(
  provider: Pick<QuotaProviderEnvelope, 'providerId' | 'displayName'> & Partial<Pick<QuotaProviderEnvelope, 'scope'>>,
  action: Exclude<ReturnType<typeof validateQuotaAction>, null>,
): string {
  if (action.kind === 'show-command') return t('quota.action.copy', { value: action.value });
  if (action.kind === 'open-url') return t('quota.action.openUrl');
  return t(provider.providerId === 'anthropic-claude-consumer' ? 'quota.action.configure' : 'quota.action.authorize');
}

export function providerEmptyStateLabel(
  provider: Pick<QuotaProviderEnvelope, 'status'>,
  action: Exclude<ReturnType<typeof validateQuotaAction>, null> | null,
): string {
  if (provider.status === 'auth-required') return t('quota.state.authRequired');
  if (provider.status === 'unsupported') return t('quota.state.unsupported');
  if (provider.status === 'error') return t('quota.state.error');
  if (action?.kind === 'open-settings') return t('quota.state.configure');
  if (action?.kind === 'show-command') return t('quota.state.command');
  if (action?.kind === 'open-url') return t('quota.state.help');
  return t('quota.state.empty');
}

const SCOPE_LABELS = localized<QuotaWindowSnapshot['scope']>({
  'consumer-subscription': 'quota.scope.consumer',
  'api-organization': 'quota.scope.apiOrg',
  'manual-budget': 'quota.scope.manual',
});

const SOURCE_LABELS = localized<QuotaWindowSnapshot['source']>({
  'official-api': 'quota.source.officialApi',
  'local-authorized': 'quota.source.local',
  manual: 'quota.source.manual',
});

const CAPABILITY_LABELS = localized<QuotaProviderEnvelope['capability']>({
  stable: 'quota.capability.stable',
  'plan-dependent': 'quota.capability.planDependent',
  experimental: 'quota.capability.experimental',
  manual: 'quota.capability.manual',
  unsupported: 'quota.capability.unsupported',
});

export function formatReset(value: string | undefined, now: number) {
  if (!value) return t('quota.reset.unknown');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('quota.reset.raw', { value });
  const diffMinutes = Math.round((date.getTime() - now) / 60_000);
  if (diffMinutes <= 0) return t('quota.reset.now');
  if (diffMinutes < 120) return t('quota.reset.minutes', { n: Math.max(1, diffMinutes) });
  if (diffMinutes < 1_440) return t('quota.reset.hours', { n: Math.round(diffMinutes / 60) });
  const absolute = new Intl.DateTimeFormat(intlLocale(), {
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date).replace(/^(周.)/, '$1 ');
  return t('quota.reset.at', { time: absolute });
}

function intlLocale(): string {
  return getLang() === 'en' ? 'en-US' : 'zh-CN';
}

function observedTime(date: Date): string {
  return new Intl.DateTimeFormat(intlLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

function observedTimeOf(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? t('quota.observed.unknown') : observedTime(date);
}

/** 公司额度与按时长命名的窗口在卡片里只写短名：「每周额度」→「每周」，Weekly quota → Weekly。 */
function shortQuotaLabel(label: string): string {
  if (label === t('quota.company.daily')) return t('quota.company.dailyShort');
  if (label === t('quota.company.monthly')) return t('quota.company.monthlyShort');
  return label
    .replace(/^(每周|每日|\d+\s*(?:分钟|小时|天))额度$/, '$1')
    .replace(/^(Weekly|Daily|\d+-(?:minute|hour|day)) quota$/, '$1');
}

function formatObserved(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('quota.observed.unknown');
  return t('quota.observed', { time: observedTime(date) });
}

function quotaWindowState(window: QuotaWindowSnapshot, now: number) {
  const rawValues = validateQuotaWindowValues(window);
  const timelineValid = validateQuotaWindowTimeline(window);
  const observedAt = timelineValid ? new Date(window.observedAt).getTime() : Number.NaN;
  const resetsAt = timelineValid && window.resetsAt
    ? new Date(window.resetsAt).getTime()
    : Number.NaN;
  const staleByAge = timelineValid && now >= observedAt + window.staleAfterSeconds * 1_000;
  const staleByReset = timelineValid && Number.isFinite(resetsAt) && resetsAt <= now;
  const freshnessStatus = timelineValid
    ? window.status === 'ok' && (staleByAge || staleByReset) ? 'stale' : window.status
    : 'error';
  const valueContractRejected = (
    rawValues === null || !timelineValid || (isCompanyQuotaProvider(window.providerId) && rawValues.kind !== 'percent')
  ) && quotaStatusAllowsValues(window.status);
  const effectiveStatus = valueContractRejected ? 'error' : freshnessStatus;
  const values = quotaStatusAllowsValues(effectiveStatus) ? rawValues : null;
  const used = values?.kind === 'percent' ? values.used : null;
  const usedDisplay = used === null ? null : Math.round(used);
  const remainingDisplay = usedDisplay === null ? null : 100 - usedDisplay;
  const effectiveReasonCode = valueContractRejected
    ? 'source_schema_unsupported'
    : window.reasonCode || (effectiveStatus === 'stale' ? 'observation_stale' : undefined);
  const effectiveReasonLabel = quotaReasonLabel(effectiveReasonCode, t('quota.windowUnavailable'));
  const hasAbsoluteValue = values?.kind === 'absolute' || values?.kind === 'unlimited';
  const absoluteUnit = window.unit === 'usd'
    ? t('quota.unit.usd')
    : window.unit === 'credits'
      ? t('quota.unit.credits')
      : window.unit === 'requests'
        ? t('quota.unit.requests')
        : window.unit === 'tokens'
          ? 'Token'
          : window.unit;
  const currency = window.unit === 'currency' ? window.currency : undefined;
  const absoluteAmount = (amount: number) => currency
    ? formatQuotaCurrencyAmount(amount, currency)
    : `${amount.toLocaleString(intlLocale())} ${absoluteUnit}`;
  const absoluteHeadline = values?.kind === 'unlimited'
    ? t('quota.unlimited')
    : values?.kind === 'absolute' && values.remaining !== undefined
      ? absoluteAmount(values.remaining)
      : values?.kind === 'absolute' && values.used !== undefined
        ? t('quota.absUsed', { amount: absoluteAmount(values.used) })
        : values?.kind === 'absolute' && values.limit !== undefined
          ? t('quota.absLimit', { amount: absoluteAmount(values.limit) })
          : '';
  return { values, used, remainingDisplay, effectiveStatus, effectiveReasonCode, effectiveReasonLabel, hasAbsoluteValue, absoluteHeadline };
}

interface QuotaDisplayGroup {
  key: string;
  label: string;
  windows: QuotaWindowSnapshot[];
}

export function quotaWindowParts(window: QuotaWindowSnapshot) {
  const fullLabel = isCompanyQuotaProvider(window.providerId)
    ? companyQuotaWindowLabel(window.windowId) || window.windowLabel
    : quotaWindowDisplayLabel(window);
  const separator = fullLabel.lastIndexOf(' · ');
  // This is display grouping, not an account identity or a wire deduplication key.
  // Only separate a prefix when a known duration/kind supplies the suffix.
  const knownKind = /^(five-hour|seven-day|weekly|primary|secondary|tertiary|.*credits.*)$/.test(quotaWindowKind(window.windowId));
  const prefix = separator > 0 && (window.windowMinutes !== undefined || knownKind)
    ? fullLabel.slice(0, separator) : '';
  const groupLabel = window.accountLabel?.trim() || prefix;
  const label = prefix && prefix === groupLabel ? fullLabel.slice(separator + 3) : fullLabel;
  return { groupLabel, label: shortQuotaLabel(label) };
}

function quotaWindowOrder(window: QuotaWindowSnapshot): number {
  if (window.windowId === 'user-daily') return 1440;
  if (window.windowId === 'user-monthly') return 43200;
  if (window.windowMinutes !== undefined) return window.windowMinutes;
  const kind = quotaWindowKind(window.windowId);
  return kind === 'five-hour' ? 300 : kind === 'seven-day' || kind === 'weekly' ? 10080 : Number.MAX_SAFE_INTEGER;
}

export function groupQuotaWindows(windows: readonly QuotaWindowSnapshot[]): QuotaDisplayGroup[] {
  const groups = new Map<string, QuotaWindowSnapshot[]>();
  for (const window of windows) {
    const label = quotaWindowParts(window).groupLabel;
    const group = groups.get(label) || [];
    group.push(window);
    groups.set(label, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN')).map(([label, entries]) => {
    const ordered = [...entries].sort((a, b) => {
      const order = quotaWindowOrder(a) - quotaWindowOrder(b);
      if (order) return order;
      const av = validateQuotaWindowValues(a), bv = validateQuotaWindowValues(b);
      const used = (bv?.kind === 'percent' ? bv.used : -1) - (av?.kind === 'percent' ? av.used : -1);
      return used || a.windowId.localeCompare(b.windowId);
    });
    return { label, windows: ordered,
      key: ordered.map(window => `${window.providerId}:${window.scope}:${window.windowId}`).sort().join('|') };
  });
}

interface QuotaPaceView {
  pace: QuotaPace;
  /** 规则层文案（T10.153 §5.2）；不预测、已用完或刚开始且已告急时为 null。 */
  copy: QuotaPaceCopy | null;
  /** 不预测的原因：只放行内详情，不给数字；额度条、历史标记或“重置时间未知”已说明的情况为 null。 */
  reason: string | null;
}

const RESET_PRECISION_UNIT_LABELS: Readonly<Record<number, MessageKey>> = { 86_400: 'quota.precision.day', 3_600: 'quota.precision.hour', 60: 'quota.precision.minute' };

/**
 * 规则层判定不预测、而额度面板别处还没说明的原因（T10.153 §3.1）。只说为什么不算，不给任何数字；
 * 已用完、历史数据、缺少重置时间与非百分比窗口已有额度条、历史标记或“重置时间未知”说明，不重复。
 */
export function quotaPaceReasonLabel(pace: QuotaPace): string | null {
  if (pace.exhausted || (pace.usedPercent !== null && pace.usedPercent >= 100)) return null;
  switch (pace.reason) {
    case 'reset-imprecise': {
      const unit = pace.resetPrecisionSeconds === null ? undefined : RESET_PRECISION_UNIT_LABELS[pace.resetPrecisionSeconds];
      return unit ? t('quota.pace.precision', { unit: t(unit) }) : t('quota.pace.imprecise');
    }
    case 'provider-experimental': return t('quota.pace.experimental');
    case 'window-length-unknown': return t('quota.pace.lengthUnknown');
    case 'timeline-inconsistent': return t('quota.pace.timeline');
    default: return null;
  }
}

function quotaPaceView(
  window: QuotaWindowSnapshot,
  now: number,
  providerCapability: QuotaProviderEnvelope['capability'],
): QuotaPaceView {
  // 第三个参数必填：窗口所属 envelope 的能力（T10.153 §3.1 第 2 条）。契约还没有 reset 精度字段，
  // 精度由规则层按时间戳推断；界面不另设来源白名单，也不自己判断哪些窗口可信。
  const pace = computeQuotaPace(window, now, { providerCapability });
  return { pace, copy: describeQuotaPace(pace, now), reason: quotaPaceReasonLabel(pace) };
}

/** 行内详情里的一句：刚开始写结论与门槛，能预测时写方法与区间，不预测时只写原因。 */
function quotaPaceDetail({ pace, copy, reason }: QuotaPaceView): string | null {
  if (!copy) return reason;
  const parts = pace.status === 'insufficient' ? [copy.text, copy.method] : [copy.method, copy.interval];
  return parts.filter(Boolean).join(t('quota.pace.join'));
}

/** 细条下方的一行速度：前置可见的“预测”标签，文字本身完整表达结论，语气只辅助着色；读屏读规则层给的整句。 */
function QuotaPaceLine({ copy }: { copy: QuotaPaceCopy }) {
  const tone = copy.tone === 'danger' ? 'text-danger' : copy.tone === 'warning' ? 'text-warning' : 'text-secondary';
  return (
    <span
      className={`quota-window-pace mt-0.5 flex flex-wrap items-center gap-x-1.5 ${tone}`}
      title={[copy.method, copy.interval].filter(Boolean).join(t('quota.pace.join'))}
    >
      <span className="sr-only">{copy.ariaLabel}</span>
      <span className="badge badge-subtle" aria-hidden="true">{copy.tag}</span>
      <span aria-hidden="true">{copy.text}</span>
    </span>
  );
}

function WindowCard({ window, now, sharedStatus, providerCapability }: {
  window: QuotaWindowSnapshot; now: number; sharedStatus?: string;
  /** 窗口所属 envelope 的能力；给出时才计算速度（余额卡不传）。 */
  providerCapability?: QuotaProviderEnvelope['capability'];
}) {
  const windowLabel = quotaWindowParts(window).label;
  const { values, used, remainingDisplay, effectiveStatus, hasAbsoluteValue, absoluteHeadline } = quotaWindowState(window, now);
  const statusLabel = t(effectiveStatus === 'stale' ? 'quota.status.stale' : 'quota.status.unavailable');
  // 行内只放能给出结论的速度；窗口刚开始与不预测的原因只在行内详情里说明（T10.153 §5.2）。
  const pace = providerCapability && used !== null ? quotaPaceView(window, now, providerCapability) : null;
  const paceCopy = pace?.copy && pace.pace.status !== 'insufficient' ? pace.copy : null;
  return (
    <div className="quota-window-gauge" data-value-kind={values?.kind || 'unavailable'}>
      <div className="quota-window-head">
        <strong title={windowLabel}>{windowLabel}</strong>
        {effectiveStatus !== 'ok' && effectiveStatus !== sharedStatus && <span className={`quota-status quota-status-${effectiveStatus}`}>{statusLabel}</span>}
        {effectiveStatus === 'ok' && <span className="sr-only">{t('quota.fresh', { observed: formatObserved(window.observedAt) })}</span>}
      </div>
      {used !== null ? (
        <>
          <div className="quota-value-row"><b>{remainingDisplay}%</b></div>
          <div className="quota-progress" data-level={quotaLevel(remainingDisplay ?? 0)}
            role="progressbar" aria-label={t('quota.meterAria', { label: windowLabel })} aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={remainingDisplay ?? undefined}
            aria-valuetext={remainingDisplay === null ? undefined : t('quota.meterText', { n: remainingDisplay })}>
            <span style={{ width: `${100 - used}%` }} />
          </div>
        </>
      ) : hasAbsoluteValue ? (
        <div className="quota-absolute-value"><strong>{absoluteHeadline}</strong></div>
      ) : <div className="quota-unavailable-copy">{t('quota.unavailableShort')}</div>}
      {used !== null && window.resetsAt && <div className="quota-window-meta">
        {formatReset(window.resetsAt, now)}
        {paceCopy && <QuotaPaceLine copy={paceCopy} />}
      </div>}
    </div>
  );
}

function QuotaDetails({ windows, now, label, providerCapability }: {
  windows: QuotaWindowSnapshot[]; now: number; label: string;
  /** 窗口所属 envelope 的能力；速度的方法、区间与不预测的原因放在这里（T10.153 §5.2、§10 第 3 条）。 */
  providerCapability?: QuotaProviderEnvelope['capability'];
}) {
  return <details className="quota-details">
    <summary aria-label={t('quota.details.aria', { label })} title={t('quota.details.title')}><ChevronDown size={16} aria-hidden="true" /><span className="sr-only">{t('quota.details.sr')}</span></summary>
    <div className="quota-details-content">
      {windows.map(window => {
        const state = quotaWindowState(window, now);
        const paceDetail = providerCapability && state.used !== null
          ? quotaPaceDetail(quotaPaceView(window, now, providerCapability))
          : null;
        return <div className="quota-detail-window" key={`${window.providerId}:${window.scope}:${window.windowId}`}>
          <strong>{quotaWindowParts(window).label}</strong>
          <span>{t(state.effectiveStatus === 'ok' ? 'quota.details.fresh' : state.effectiveStatus === 'stale' ? 'quota.details.stale' : 'quota.status.unavailable')}</span>
          {state.effectiveReasonCode && <p>{state.effectiveReasonLabel}</p>}
          <span>{t('quota.details.read', { observed: formatObserved(window.observedAt), fetched: observedTimeOf(window.fetchedAt) })}</span>
          {!window.resetsAt && !isCompanyQuotaProvider(window.providerId) && <span>{t('quota.reset.unknown')}</span>}
          <span>{SCOPE_LABELS[window.scope]} · {SOURCE_LABELS[window.source]}</span>
          {paceDetail && <span className="quota-detail-pace">{t('quota.details.pace', { detail: paceDetail })}</span>}
        </div>;
      })}
    </div>
  </details>;
}

export function ProviderEmpty({
  provider,
  onOpenSettings,
  onNotify,
  compact = false,
  reasonOverride,
}: {
  provider: QuotaProviderEnvelope;
  onOpenSettings: () => void;
  onNotify: (message: string) => void;
  compact?: boolean;
  reasonOverride?: string;
}) {
  const [actionBusy, setActionBusy] = useState(false);
  const reason = reasonOverride || quotaReasonLabel(provider.reasonCode, t('quota.empty.reason'));
  const safeAction = validateQuotaAction(provider.providerId, provider.action);
  const showCommand = safeAction?.kind === 'show-command';
  const openUrl = safeAction?.kind === 'open-url';
  const actionLabel = safeAction
    ? actionBusy
      ? t('quota.empty.copying')
      : providerEmptyActionLabel(provider, safeAction)
    : null;
  const actionAriaLabel = safeAction
    ? actionBusy
      ? t('quota.empty.copyingAria', { name: providerDisplayName(provider) })
      : t('quota.empty.actionAria', { name: providerDisplayName(provider), action: providerEmptyActionLabel(provider, safeAction) })
    : null;
  const performAction = async () => {
    if (actionBusy) return;
    if (safeAction?.kind === 'open-settings') {
      onOpenSettings();
      return;
    }
    if (showCommand) {
      setActionBusy(true);
      try {
        await navigator.clipboard.writeText(safeAction.value);
        onNotify(t('quota.empty.copied', { value: safeAction.value }));
      } catch {
        onNotify(t('quota.empty.typeInClaude', { value: safeAction.value }));
      } finally {
        setActionBusy(false);
      }
      return;
    }
    if (openUrl) {
      const opened = window.open(safeAction.value, '_blank', 'noopener,noreferrer');
      if (!opened) onNotify(t('quota.empty.openHelp'));
    }
  };
  return (
    <div className={`quota-provider-empty${compact ? ' quota-provider-empty-compact' : ''}`}>
      <div className="quota-provider-icon">
          {showCommand ? <Command className="h-5 w-5" /> : <Settings2 className="h-5 w-5" />}
      </div>
      <div className="quota-provider-empty-copy">
        <div className="quota-provider-empty-heading">
          <strong>{t('quota.empty.title')}</strong>
          <span className={`quota-provider-state quota-provider-state-${provider.status}`}>{providerEmptyStateLabel(provider, safeAction)}</span>
        </div>
        <span>{reason}</span>
      </div>
      {safeAction && (
        <button
          className="secondary-inline"
          type="button"
          aria-label={actionAriaLabel || undefined}
          aria-busy={actionBusy || undefined}
          title={actionBusy ? actionAriaLabel || undefined : t('quota.empty.actionAria', { name: providerDisplayName(provider), action: providerEmptyActionLabel(provider, safeAction) })}
          onClick={performAction}
          disabled={actionBusy}
        >
          {actionBusy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {actionLabel}
        </button>
      )}
    </div>
  );
}

interface QuotaProviderView {
  provider: QuotaProviderEnvelope;
  presentationProvider: QuotaProviderEnvelope;
  companyProvider: boolean;
  companyWindows: QuotaWindowSnapshot[];
  hasRenderableWindows: boolean;
}

function QuotaProviderCard({ view, group, pending = false, now, onOpenSettings, onNotify }: {
  view: QuotaProviderView; group?: QuotaDisplayGroup; pending?: boolean; now: number;
  onOpenSettings: () => void; onNotify: (message: string) => void;
}) {
  const { provider, presentationProvider, companyProvider } = view;
  const providerHeadingId = useId();
  const windows = group?.windows || [];
  const states = windows.map(window => quotaWindowState(window, now));
  const sharedStatus = states.length && states.every(state => state.effectiveStatus === states[0].effectiveStatus)
    ? states[0].effectiveStatus : undefined;
  const meters = windows.filter((_, i) => !states[i].hasAbsoluteValue);
  const balances = windows.filter((_, i) => states[i].hasAbsoluteValue);
  const name = providerDisplayName(presentationProvider);
  const hasBrandLogo = !companyProvider && Boolean(resolveBrandIconKey(provider.providerId) || resolveBrandIconKey(name));
  const ProviderIcon = companyProvider ? (name.includes('外网') ? Globe2 : Network)
    : provider.providerId.includes('claude') ? Sparkles : Terminal;
  return (
    <article className={pending ? 'quota-provider-pending' : 'quota-provider'} aria-labelledby={providerHeadingId}
      data-provider-kind={companyProvider ? 'company' : 'standard'}
      data-provider-tone={provider.providerId.includes('claude') ? 'claude' : provider.providerId.includes('antigravity') ? 'antigravity' : 'codex'}>
      <header className="quota-card-header">
        <span className="quota-source-icon" aria-hidden="true">
          {hasBrandLogo ? <BrandIcon name={provider.providerId || name} size={20} /> : <ProviderIcon size={20} strokeWidth={1.7} />}
        </span>
        <div className="quota-source-copy">
          <h3 id={providerHeadingId} className="quota-provider-title">
            <strong title={`${CAPABILITY_LABELS[provider.capability]} · ${SCOPE_LABELS[provider.scope]}`}>{name}</strong>
            {group?.label && <span className="quota-account-name">{group.label}</span>}
          </h3>
          {!pending && sharedStatus && sharedStatus !== 'ok' && <span className={`quota-status quota-status-${sharedStatus}`}>{t(sharedStatus === 'stale' ? 'quota.status.stale' : 'quota.status.unavailable')}</span>}
          {balances.length > 0 && <div className="quota-balances">{balances.map(window => <WindowCard key={`${window.providerId}:${window.scope}:${window.windowId}`}
            window={window} now={now} sharedStatus={sharedStatus} />)}</div>}
        </div>
      </header>
      {pending ? <ProviderEmpty provider={presentationProvider} compact
        reasonOverride={companyProvider ? t('quota.company.empty') : undefined}
        onOpenSettings={onOpenSettings} onNotify={onNotify} />
      : presentationProvider.status === 'ok' || presentationProvider.status === 'stale' ? <>
        <div className="quota-window-list">
          {meters.map(window => <WindowCard key={`${window.providerId}:${window.scope}:${window.windowId}`}
            window={window} now={now} sharedStatus={sharedStatus} providerCapability={provider.capability} />)}
        </div>
        <QuotaDetails windows={windows} now={now} label={group?.label ? `${name} · ${group.label}` : name} providerCapability={provider.capability} />
      </> : null}
    </article>
  );
}

export function QuotaPanel({
  providers,
  loading,
  error,
  showRecoveryActions = true,
  quotaSyncStatus,
  onRefresh,
  onSyncNow,
  onOpenSettings,
  onNotify,
  sourceOrder = [],
  hiddenSourceIds = [],
}: QuotaPanelProps) {
  useLang();
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  // Sync status is owned by App (single source of truth); the refresh button
  // reloads providers and, when cross-device sync is enabled, delegates the
  // upload to App's handler. App keeps the sole quota-sync-updated listener.
  const refreshQuota = () => {
    onRefresh();
    if (quotaSyncStatus.enabled) onSyncNow();
  };
  const quotaSyncBusy = quotaSyncStatus.state === 'syncing';
  const quotaRefreshBusy = loading || quotaSyncBusy;
  const quotaRefreshButtonLabel = t(loading ? 'quota.refresh.loading' : quotaSyncBusy ? 'quota.refresh.syncing' : 'quota.refresh');
  const quotaRefreshAriaLabel = t(loading ? 'quota.refresh.loadingAria' : quotaSyncBusy ? 'quota.refresh.syncingAria' : 'quota.refresh');
  const providerViews: QuotaProviderView[] = (providers || []).map((provider) => {
    const envelopeValid = validateQuotaProviderEnvelopeStructure(provider);
    const companyProvider = isCompanyQuotaProvider(provider.providerId);
    const presentationProvider: QuotaProviderEnvelope = envelopeValid ? provider : {
      ...provider,
      status: 'error',
      windows: [],
      reasonCode: 'source_schema_unsupported',
      action: undefined,
    };
    const companyWindows = companyProvider
      ? selectCompanyQuotaWindows(presentationProvider.windows)
      : [];
    return {
      provider,
      presentationProvider,
      companyProvider,
      companyWindows,
      hasRenderableWindows: quotaProviderHasRenderableWindows(presentationProvider),
    };
  });
  const sourceKey = (view: QuotaProviderView) => `${view.provider.providerId}:${view.provider.scope}`;
  const orderedProviderViews = [...providerViews].sort((left, right) => {
    const leftIndex = sourceOrder.indexOf(sourceKey(left));
    const rightIndex = sourceOrder.indexOf(sourceKey(right));
    const normalizedLeft = leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const normalizedRight = rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex;
    return normalizedLeft - normalizedRight;
  });
  // Keep a final source visible even when stale storage says every current
  // source is hidden. The dialog uses this same helper, so the UI agrees.
  const displayedSourceKeys = new Set(effectiveVisibleQuotaSourceKeys(orderedProviderViews.map(sourceKey), {
    quotaSourceOrder: sourceOrder,
    hiddenQuotaSourceIds: hiddenSourceIds,
  }));
  const displayedProviderViews = orderedProviderViews.filter(view => displayedSourceKeys.has(sourceKey(view)));
  // 待处理来源默认折叠成一行（REQ-QUOTA-03）：它们不是额度，只是还没授权的入口。
  const [pendingExpanded, setPendingExpanded] = useState(false);
  const pendingListId = useId();
  const renderableProviders = displayedProviderViews.filter((view) => view.hasRenderableWindows);
  const pendingProviders = displayedProviderViews.filter((view) => !view.hasRenderableWindows);
  const hasProviderSnapshot = providers.length > 0;
  return (
    <section className="panel quota-panel" aria-labelledby="quota-panel-title" aria-busy={quotaRefreshBusy}>
      <div className="quota-panel-head">
        <div>
          <h2 id="quota-panel-title" className="panel-title" title={t('quota.panel.titleHint')}>
            <span className="panel-icon tone-primary" aria-hidden="true"><Gauge className="h-4 w-4" /></span>
            {t('quota.panel.title')}
            {quotaSyncStatus.enabled && <span className="quota-sync-badge">{t('quota.panel.syncBadge')}</span>}
            <span className="sr-only">{t('quota.panel.sr')}</span>
          </h2>
          <p className="quota-panel-subtitle">{t('quota.panel.subtitle')}</p>
          {quotaSyncStatus.state === 'paused' && (
            <p role="status">{t('quota.panel.paused')}</p>
          )}
        </div>
        <div className="quota-panel-actions">
          {(!error || showRecoveryActions) && (
            <button
              className="ghost-inline quota-refresh"
              type="button"
              aria-label={quotaRefreshAriaLabel}
              title={quotaRefreshBusy ? quotaRefreshAriaLabel : t('quota.refresh.title')}
              onClick={refreshQuota}
              disabled={quotaRefreshBusy}
            >
              <RefreshCw className={`h-4 w-4 ${quotaRefreshBusy ? 'animate-spin' : ''}`} />
              <span className="quota-refresh-label">{quotaRefreshButtonLabel}</span>
            </button>
          )}
        </div>
      </div>
      {error && (showRecoveryActions ? (
        <div className="quota-panel-error" role="alert">
          <div className="quota-panel-error-copy">
            <strong>{t('quota.error.title')}</strong>
            <span>{error}</span>
            <span className="quota-panel-error-detail">{t('quota.error.detail')}</span>
            {hasProviderSnapshot && <span className="quota-panel-error-detail">{t('quota.error.snapshot')}</span>}
          </div>
          <div className="quota-panel-error-actions">
            <button className="ghost-inline" type="button" onClick={onOpenSettings} disabled={quotaRefreshBusy}>
              {t('quota.error.check')}
            </button>
          </div>
        </div>
      ) : (
        <div className="quota-panel-error quota-panel-error-context" role="status" aria-label={t('quota.error.statusAria')}>
          <div className="quota-panel-error-copy">
            <strong>{t('quota.error.incomplete')}</strong>
            <span>{error}</span>
            {hasProviderSnapshot && <span className="quota-panel-error-detail">{t('quota.error.snapshotTop')}</span>}
          </div>
        </div>
      ))}
      {providers.length === 0 && loading ? (
        <div className="quota-panel-loading">{t('quota.loading')}</div>
      ) : (
        <>
          {renderableProviders.length > 0 && (
            <div className="quota-dashboard" aria-label={t('quota.dashboardAria')}>
              {renderableProviders.flatMap(view => groupQuotaWindows(view.companyProvider ? view.companyWindows : view.presentationProvider.windows).map(group => (
                <QuotaProviderCard key={group.key} view={view} group={group} now={clock}
                  onOpenSettings={onOpenSettings} onNotify={onNotify} />
              )))}
            </div>
          )}
          {pendingProviders.length > 0 && (
            <section
              className="quota-pending-providers"
              aria-labelledby="quota-pending-title"
              data-expanded={pendingExpanded ? 'true' : 'false'}
            >
              <div className="quota-pending-head">
                <h3 id="quota-pending-title">{t('quota.pending.title')}</h3>
                <button
                  type="button"
                  className="link-inline quota-pending-toggle"
                  aria-expanded={pendingExpanded}
                  aria-controls={pendingListId}
                  onClick={() => setPendingExpanded((value) => !value)}
                >
                  <span>{t('quota.pending.count', { count: pendingProviders.length })}</span>
                  {t(pendingExpanded ? 'quota.pending.collapse' : 'quota.pending.expand')}
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
              </div>
              {pendingExpanded ? (
                <div className="quota-pending-list" id={pendingListId}>
                  {pendingProviders.map((view) => (
                    <QuotaProviderCard
                      key={`${view.provider.providerId}:${view.provider.scope}`}
                      view={view}
                      pending
                      now={clock}
                      onOpenSettings={onOpenSettings}
                      onNotify={onNotify}
                    />
                  ))}
                </div>
              ) : (
                <div className="quota-pending-summary" id={pendingListId}>
                  <span
                    className="quota-pending-summary-names"
                    title={pendingProviders.map((view) => providerDisplayName(view.presentationProvider)).join(' · ')}
                  >
                    {pendingProviders.map((view) => providerDisplayName(view.presentationProvider)).join(' · ')}
                  </span>
                  <div className="quota-pending-summary-actions">
                    <button type="button" className="ghost-inline" onClick={onOpenSettings}>{t('quota.pending.authorize')}</button>
                  </div>
                </div>
              )}
            </section>
          )}
          {providers.length === 0 && !error && (
            // 冷启动会有一段安静的空窗：T10.71 移除了启动时的额度同步（避免一开机
            // 就弹钥匙串），首次后台读取改由 5 分钟周期接手。在此之前面板原本什么
            // 都不显示，用户无法区分「还没读」和「没有来源」。两种情况各给一条出路。
            <EmptyState
              variant="inset"
              icon={Gauge}
              className="quota-panel-cold-start"
              title={t('empty.quota.title')}
              description={t('empty.quota.description')}
            >
              <button type="button" className="secondary-inline" onClick={onOpenSettings}>{t('empty.quota.action')}</button>
            </EmptyState>
          )}
        </>
      )}
    </section>
  );
}

export default QuotaPanel;
