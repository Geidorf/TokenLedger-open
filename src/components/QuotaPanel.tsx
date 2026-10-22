import { ChevronDown, Command, Gauge, Globe2, LoaderCircle, Network, RefreshCw, Settings2, Sparkles, Terminal } from 'lucide-react';
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

const REASON_LABELS: Record<string, string> = {
  local_authorization_required: '需要在设置中明确授权本地额度读取',
  claude_local_authorization_required: '请在设置中选择 Claude Code status line 或内置 Claude 桌面版读取',
  claude_statusline_snapshot_missing: '尚未收到 Claude Code status line 快照；Claude 桌面版可改用内置授权读取',
  claude_statusline_snapshot_invalid: 'Claude Code 额度快照无效或已被拒绝',
  claude_native_authorization_required: '请在设置中为 TokenLedger 授权 Claude 本地额度读取',
  claude_native_cli_unavailable: '未找到 Claude 桌面版内置代理或 Claude Code',
  claude_native_timeout: 'Claude 本地 /usage 读取超时，已保留最近有效快照',
  claude_native_usage_unavailable: 'Claude Desktop 额度页可能正常，但本机 Claude CLI 的 /usage 通道当前加载失败；请稍后重试或在 Claude Code 中重新登录',
  claude_native_subscription_unavailable: '当前 Claude 订阅没有返回可量化的额度窗口',
  claude_native_response_invalid: 'Claude 本地 /usage 未返回可验证的额度窗口',
  claude_codexbar_unavailable: '未找到 CodexBar CLI，已尝试 Claude 内置 /usage 回退',
  claude_codexbar_timeout: 'CodexBar Claude 额度读取超时，已保留最近有效快照',
  claude_codexbar_response_invalid: 'CodexBar 未返回可验证的 Claude 消费者额度；请在 CodexBar 中确认 Claude 来源已授权',
  antigravity_local_authorization_required: '请在设置中明确授权 Antigravity 本地额度读取',
  antigravity_native_authorization_required: '请先在 Antigravity 中完成登录',
  antigravity_native_source_not_found: '未发现正在运行的 Antigravity App、IDE 或 agy 本地服务',
  antigravity_native_port_unavailable: '未发现 Antigravity 本地额度服务端口',
  antigravity_native_timeout: 'Antigravity 本地额度读取超时，已保留最近有效快照',
  antigravity_native_response_invalid: 'Antigravity 本地服务未返回可验证的额度窗口',
  antigravity_codexbar_unavailable: '内置读取失败，且未找到可用的 CodexBar CLI 兜底',
  antigravity_codexbar_timeout: 'CodexBar 的 Antigravity 额度读取超时',
  antigravity_codexbar_response_invalid: 'CodexBar 未返回可验证的 Antigravity 本地额度',
  consumer_api_unavailable: '当前计划没有可用的消费者额度来源',
  source_not_found: '未找到可读取的本地额度来源',
  app_server_unavailable: 'Codex app-server 暂不可用，旧版客户端可回退到实验性本地快照',
  app_server_timeout: 'Codex app-server 响应超时，已保留最近有效快照',
  app_server_auth_required: 'Codex 当前未完成 ChatGPT 登录或账户额度不可用',
  permission_denied: '本地额度来源没有读取权限',
  secure_storage_unavailable: '系统安全存储暂时无法读取；后台不会重复尝试，请确认钥匙串已解锁后点击刷新额度',
  source_schema_unsupported: '当前客户端的额度数据格式暂不兼容',
  source_scan_truncated: '受限扫描未能证明数据完整，请稍后重试',
  source_temporarily_unavailable: '本地数据源暂时不可读，已保留最近有效快照',
  observation_stale: '这是最近一次有效快照，当前数据源暂未刷新',
  reset_elapsed: '额度窗口已到重置时间，等待来源刷新',
  provider_worker_failed: '额度读取进程暂时失败',
  provider_cache_unavailable: '最近有效额度快照不可读取',
  credits_unlimited: '该账户的额外用量不设固定上限',
  admin_key_required: '需要配置对应组织额度来源的管理凭据',
  api_key_required: '需要在设置中配置或更新这个公司额度来源的 API key',
  rate_limited: '额度来源请求过于频繁，请稍后重试',
  upstream_unavailable: '额度来源服务暂时不可用',
  balance_unavailable: '供应商余额接口没有返回可验证的余额数值或币种，已保留最近有效余额',
  experimental_consent_required: '实验性套餐的风险提示有更新，在设置中重新确认后才会读取',
};

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
const COMPANY_QUOTA_WINDOW_LABELS = new Map([
  ['user-daily', '今日可用额度'],
  ['user-monthly', '本月可用额度'],
]);

export function isCompanyQuotaProvider(providerId: string): boolean {
  return providerId.startsWith(COMPANY_QUOTA_PROVIDER_PREFIX);
}

export function companyQuotaWindowLabel(windowId: string): string | null {
  return COMPANY_QUOTA_WINDOW_LABELS.get(windowId) ?? null;
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
  if (minutes === 7 * 24 * 60) return '每周额度';
  if (minutes === 24 * 60) return '每日额度';
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} 天额度`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时额度`;
  return `${minutes} 分钟额度`;
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
    ? '额外用量余额'
    : window.windowMinutes !== undefined
      ? localizedQuotaDuration(window.windowMinutes)
      : kind === 'five-hour'
        ? '5 小时额度'
        : kind === 'seven-day' || kind === 'weekly'
          ? '每周额度'
          : kind === 'primary'
            ? '主要额度窗口'
            : kind === 'secondary'
              ? '次要额度窗口'
              : kind === 'tertiary'
                ? '附加额度窗口'
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
  return reasonCode ? REASON_LABELS[reasonCode] || fallback : fallback;
}

function providerEmptyActionLabel(
  provider: Pick<QuotaProviderEnvelope, 'providerId' | 'displayName'> & Partial<Pick<QuotaProviderEnvelope, 'scope'>>,
  action: Exclude<ReturnType<typeof validateQuotaAction>, null>,
): string {
  if (action.kind === 'show-command') return `复制 ${action.value}`;
  if (action.kind === 'open-url') return '打开服务商页面';
  return provider.providerId === 'anthropic-claude-consumer' ? '配置读取' : '授权读取';
}

export function providerEmptyStateLabel(
  provider: Pick<QuotaProviderEnvelope, 'status'>,
  action: Exclude<ReturnType<typeof validateQuotaAction>, null> | null,
): string {
  if (provider.status === 'auth-required') return '需要授权';
  if (provider.status === 'unsupported') return '来源不可用';
  if (provider.status === 'error') return '读取失败';
  if (action?.kind === 'open-settings') return '待配置';
  if (action?.kind === 'show-command') return '待执行';
  if (action?.kind === 'open-url') return '查看帮助';
  return '暂无数据';
}

const SCOPE_LABELS: Record<QuotaWindowSnapshot['scope'], string> = {
  'consumer-subscription': '消费者订阅',
  'api-organization': 'API 组织',
  'manual-budget': '手动预算',
};

const SOURCE_LABELS: Record<QuotaWindowSnapshot['source'], string> = {
  'official-api': '官方 API',
  'local-authorized': '官方客户端本地授权',
  manual: '手动录入',
};

const CAPABILITY_LABELS: Record<QuotaProviderEnvelope['capability'], string> = {
  stable: '稳定能力',
  'plan-dependent': '计划相关',
  experimental: '增强来源 · 实验',
  manual: '手工来源',
  unsupported: '暂不可用',
};

export function formatReset(value: string | undefined, now: number) {
  if (!value) return '重置时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return `重置 ${value}`;
  const diffMinutes = Math.round((date.getTime() - now) / 60_000);
  if (diffMinutes <= 0) return '正在重置';
  if (diffMinutes < 120) return `${Math.max(1, diffMinutes)} 分钟后重置`;
  if (diffMinutes < 1_440) return `${Math.round(diffMinutes / 60)} 小时后重置`;
  const absolute = new Intl.DateTimeFormat('zh-CN', {
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date).replace(/^(周.)/, '$1 ');
  return `${absolute} 重置`;
}

function formatObserved(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '观测时间未知';
  return `观测 ${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)}`;
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
  const effectiveReasonLabel = quotaReasonLabel(effectiveReasonCode, '额度窗口状态暂不可用');
  const hasAbsoluteValue = values?.kind === 'absolute' || values?.kind === 'unlimited';
  const absoluteUnit = window.unit === 'usd'
    ? '美元'
    : window.unit === 'credits'
      ? '额度点'
      : window.unit === 'requests'
        ? '次请求'
        : window.unit === 'tokens'
          ? 'Token'
          : window.unit;
  const currency = window.unit === 'currency' ? window.currency : undefined;
  const absoluteAmount = (amount: number) => currency
    ? formatQuotaCurrencyAmount(amount, currency)
    : `${amount.toLocaleString('zh-CN')} ${absoluteUnit}`;
  const absoluteHeadline = values?.kind === 'unlimited'
    ? '额外用量不限额'
    : values?.kind === 'absolute' && values.remaining !== undefined
      ? absoluteAmount(values.remaining)
      : values?.kind === 'absolute' && values.used !== undefined
        ? `${absoluteAmount(values.used)} 已使用`
        : values?.kind === 'absolute' && values.limit !== undefined
          ? `${absoluteAmount(values.limit)} 上限`
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
  return { groupLabel, label: label.replace(/^今日可用额度$/, '今日').replace(/^本月可用额度$/, '本月').replace(/^(每周|每日|\d+\s*(?:分钟|小时|天))额度$/, '$1') };
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

const RESET_PRECISION_UNIT_LABELS: Readonly<Record<number, string>> = { 86_400: '天', 3_600: '小时', 60: '分钟' };

/**
 * 规则层判定不预测、而额度面板别处还没说明的原因（T10.153 §3.1）。只说为什么不算，不给任何数字；
 * 已用完、历史数据、缺少重置时间与非百分比窗口已有额度条、历史标记或“重置时间未知”说明，不重复。
 */
export function quotaPaceReasonLabel(pace: QuotaPace): string | null {
  if (pace.exhausted || (pace.usedPercent !== null && pace.usedPercent >= 100)) return null;
  switch (pace.reason) {
    case 'reset-imprecise': {
      const unit = pace.resetPrecisionSeconds === null ? undefined : RESET_PRECISION_UNIT_LABELS[pace.resetPrecisionSeconds];
      return unit ? `重置时间只精确到${unit}，暂不计算速度` : '重置时间精度不足，暂不计算速度';
    }
    case 'provider-experimental': return '实验性来源的窗口时长或重置时间可能不准，暂不计算速度';
    case 'window-length-unknown': return '窗口时长未知，暂不计算速度';
    case 'timeline-inconsistent': return '观测时间不在当前窗口内，暂不计算速度';
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
  return parts.filter(Boolean).join('；');
}

/** 细条下方的一行速度：前置可见的“预测”标签，文字本身完整表达结论，语气只辅助着色；读屏读规则层给的整句。 */
function QuotaPaceLine({ copy }: { copy: QuotaPaceCopy }) {
  const tone = copy.tone === 'danger' ? 'text-danger' : copy.tone === 'warning' ? 'text-warning' : 'text-secondary';
  return (
    <span
      className={`quota-window-pace mt-0.5 flex flex-wrap items-center gap-x-1.5 ${tone}`}
      title={[copy.method, copy.interval].filter(Boolean).join('；')}
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
  const statusLabel = effectiveStatus === 'stale' ? '历史数据' : '不可用';
  // 行内只放能给出结论的速度；窗口刚开始与不预测的原因只在行内详情里说明（T10.153 §5.2）。
  const pace = providerCapability && used !== null ? quotaPaceView(window, now, providerCapability) : null;
  const paceCopy = pace?.copy && pace.pace.status !== 'insufficient' ? pace.copy : null;
  return (
    <div className="quota-window-gauge" data-value-kind={values?.kind || 'unavailable'}>
      <div className="quota-window-head">
        <strong title={windowLabel}>{windowLabel}</strong>
        {effectiveStatus !== 'ok' && effectiveStatus !== sharedStatus && <span className={`quota-status quota-status-${effectiveStatus}`}>{statusLabel}</span>}
        {effectiveStatus === 'ok' && <span className="sr-only">数据最新，{formatObserved(window.observedAt)}</span>}
      </div>
      {used !== null ? (
        <>
          <div className="quota-value-row"><b>{remainingDisplay}%</b></div>
          <div className="quota-progress" data-level={quotaLevel(remainingDisplay ?? 0)}
            role="progressbar" aria-label={`${windowLabel} 可用额度`} aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={remainingDisplay ?? undefined}
            aria-valuetext={remainingDisplay === null ? undefined : `${remainingDisplay}% 可用`}>
            <span style={{ width: `${100 - used}%` }} />
          </div>
        </>
      ) : hasAbsoluteValue ? (
        <div className="quota-absolute-value"><strong>{absoluteHeadline}</strong></div>
      ) : <div className="quota-unavailable-copy">暂不可用</div>}
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
    <summary aria-label={`${label}：查看额度详情`} title="查看额度详情"><ChevronDown size={16} aria-hidden="true" /><span className="sr-only">详情</span></summary>
    <div className="quota-details-content">
      {windows.map(window => {
        const state = quotaWindowState(window, now);
        const paceDetail = providerCapability && state.used !== null
          ? quotaPaceDetail(quotaPaceView(window, now, providerCapability))
          : null;
        return <div className="quota-detail-window" key={`${window.providerId}:${window.scope}:${window.windowId}`}>
          <strong>{quotaWindowParts(window).label}</strong>
          <span>{state.effectiveStatus === 'ok' ? '数据最新' : state.effectiveStatus === 'stale' ? '历史快照' : '不可用'}</span>
          {state.effectiveReasonCode && <p>{state.effectiveReasonLabel}</p>}
          <span>{formatObserved(window.observedAt)} · 读取 {formatObserved(window.fetchedAt).replace(/^观测 /, '')}</span>
          {!window.resetsAt && !isCompanyQuotaProvider(window.providerId) && <span>重置时间未知</span>}
          <span>{SCOPE_LABELS[window.scope]} · {SOURCE_LABELS[window.source]}</span>
          {paceDetail && <span className="quota-detail-pace">预测 · {paceDetail}</span>}
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
  const reason = reasonOverride || quotaReasonLabel(provider.reasonCode, '当前没有可用额度数据');
  const safeAction = validateQuotaAction(provider.providerId, provider.action);
  const showCommand = safeAction?.kind === 'show-command';
  const openUrl = safeAction?.kind === 'open-url';
  const actionLabel = safeAction
    ? actionBusy
      ? '复制中…'
      : providerEmptyActionLabel(provider, safeAction)
    : null;
  const actionAriaLabel = safeAction
    ? actionBusy
      ? `${providerDisplayName(provider)}：正在复制指令`
      : `${providerDisplayName(provider)}：${providerEmptyActionLabel(provider, safeAction)}`
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
        onNotify(`已复制 ${safeAction.value}`);
      } catch {
        onNotify(`请在 Claude 中输入 ${safeAction.value}`);
      } finally {
        setActionBusy(false);
      }
      return;
    }
    if (openUrl) {
      const opened = window.open(safeAction.value, '_blank', 'noopener,noreferrer');
      if (!opened) onNotify('请在设置中查看服务商帮助页面');
    }
  };
  return (
    <div className={`quota-provider-empty${compact ? ' quota-provider-empty-compact' : ''}`}>
      <div className="quota-provider-icon">
          {showCommand ? <Command className="h-5 w-5" /> : <Settings2 className="h-5 w-5" />}
      </div>
      <div className="quota-provider-empty-copy">
        <div className="quota-provider-empty-heading">
          <strong>尚无可展示额度</strong>
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
          title={actionBusy ? actionAriaLabel || undefined : `${providerDisplayName(provider)}：${providerEmptyActionLabel(provider, safeAction)}`}
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
          {!pending && sharedStatus && sharedStatus !== 'ok' && <span className={`quota-status quota-status-${sharedStatus}`}>{sharedStatus === 'stale' ? '历史数据' : '不可用'}</span>}
          {balances.length > 0 && <div className="quota-balances">{balances.map(window => <WindowCard key={`${window.providerId}:${window.scope}:${window.windowId}`}
            window={window} now={now} sharedStatus={sharedStatus} />)}</div>}
        </div>
      </header>
      {pending ? <ProviderEmpty provider={presentationProvider} compact
        reasonOverride={companyProvider ? '当前没有可展示的用户日额度或用户月额度。' : undefined}
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
  const quotaRefreshButtonLabel = loading ? '读取中…' : quotaSyncBusy ? '同步中…' : '刷新额度';
  const quotaRefreshAriaLabel = loading ? '正在读取额度' : quotaSyncBusy ? '正在同步额度' : '刷新额度';
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
          <h2 id="quota-panel-title" className="panel-title" title="仅展示来源返回的真实额度，不推算未提供的余额">
            <span className="panel-icon tone-primary" aria-hidden="true"><Gauge className="h-4 w-4" /></span>
            订阅额度
            {quotaSyncStatus.enabled && <span className="quota-sync-badge">跨设备同步</span>}
            <span className="sr-only">来源快照，不推算未提供的余额。</span>
          </h2>
          <p className="quota-panel-subtitle">剩余额度</p>
          {quotaSyncStatus.state === 'paused' && (
            <p role="status">跨设备同步已暂停；请在设置中重新显式启用，不会自动恢复。</p>
          )}
        </div>
        <div className="quota-panel-actions">
          {(!error || showRecoveryActions) && (
            <button
              className="ghost-inline quota-refresh"
              type="button"
              aria-label={quotaRefreshAriaLabel}
              title={quotaRefreshBusy ? quotaRefreshAriaLabel : '重新读取本机与已授权的额度来源'}
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
            <strong>额度暂时无法更新</strong>
            <span>{error}</span>
            <span className="quota-panel-error-detail">不会推算未提供的余额。可以重新读取额度，或检查来源配置。</span>
            {hasProviderSnapshot && <span className="quota-panel-error-detail">仍显示上次读取到的来源结果。</span>}
          </div>
          <div className="quota-panel-error-actions">
            <button className="ghost-inline" type="button" onClick={onOpenSettings} disabled={quotaRefreshBusy}>
              检查额度来源
            </button>
          </div>
        </div>
      ) : (
        <div className="quota-panel-error quota-panel-error-context" role="status" aria-label="额度读取状态">
          <div className="quota-panel-error-copy">
            <strong>本次读取未完成</strong>
            <span>{error}</span>
            {hasProviderSnapshot && <span className="quota-panel-error-detail">仍显示上次读取到的来源结果；恢复操作位于看板顶部。</span>}
          </div>
        </div>
      ))}
      {providers.length === 0 && loading ? (
        <div className="quota-panel-loading">正在读取额度能力…</div>
      ) : (
        <>
          {renderableProviders.length > 0 && (
            <div className="quota-dashboard" aria-label="服务商额度仪表盘">
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
                <h3 id="quota-pending-title">待处理来源</h3>
                <button
                  type="button"
                  className="link-inline quota-pending-toggle"
                  aria-expanded={pendingExpanded}
                  aria-controls={pendingListId}
                  onClick={() => setPendingExpanded((value) => !value)}
                >
                  <span>{pendingProviders.length} 个来源没有可展示额度</span>
                  {pendingExpanded ? '收起' : '展开'}
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
                    <button type="button" className="ghost-inline" onClick={onOpenSettings}>去设置授权</button>
                  </div>
                </div>
              )}
            </section>
          )}
          {providers.length === 0 && !error && (
            // 冷启动会有一段安静的空窗：T10.71 移除了启动时的额度同步（避免一开机
            // 就弹钥匙串），首次后台读取改由 5 分钟周期接手。在此之前面板原本什么
            // 都不显示，用户无法区分「还没读」和「没有来源」。两种情况各给一条出路。
            <p className="quota-panel-cold-start" role="status">
              还没有任何额度快照。已授权来源的首次后台读取会在应用启动约 5 分钟后进行，想立刻查看请点上方「刷新额度」；
              <button type="button" className="link-inline" onClick={onOpenSettings}>
                还没授权任何来源？去设置开启
              </button>
            </p>
          )}
        </>
      )}
    </section>
  );
}

export default QuotaPanel;
