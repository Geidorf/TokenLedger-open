import type { AppSettings, StatsData } from '../../types';

export type CloudFailureKind = 'session-expired' | 'capability-missing' | 'offline' | 'permission' | 'range-unsupported' | 'service';

export interface CloudFailureDescription {
  kind: CloudFailureKind;
  label: string;
  message: string;
}

export interface SuccessfulCloudSyncResult {
  success: true;
  message: string;
  warning?: string | null;
}

const CLOUD_STATS_SNAPSHOT_PREFIX = 'cloud\u001e';

export function normalizeCloudOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:')
      || url.username
      || url.password
      || url.origin === 'null'
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function cloudStatsIdentity(origin: unknown, userId: unknown): string | null {
  const normalizedOrigin = normalizeCloudOrigin(origin);
  const normalizedUserId = typeof userId === 'string' ? userId.trim() : '';
  if (!normalizedOrigin || !normalizedUserId) return null;
  return `${encodeURIComponent(normalizedOrigin)}\u001f${encodeURIComponent(normalizedUserId)}`;
}

export function statsSnapshotKey(
  scope: 'local' | 'cloud',
  range: string,
  deviceFilter: string,
  cloudOrigin?: unknown,
  cloudUserId?: unknown,
): string | null {
  if (scope === 'local') return `local\u001e${range}\u001eall_cloud`;
  const identity = cloudStatsIdentity(cloudOrigin, cloudUserId);
  if (!identity) return null;
  return `${CLOUD_STATS_SNAPSHOT_PREFIX}${identity}\u001e${range}\u001e${deviceFilter}`;
}

export function clearCloudStatsSnapshots<T>(snapshots: Map<string, T>): void {
  for (const key of snapshots.keys()) {
    if (key.startsWith(CLOUD_STATS_SNAPSHOT_PREFIX)) snapshots.delete(key);
  }
}

export type WallpaperConsentResolution =
  | { kind: 'ready'; settings: AppSettings }
  | { kind: 'blocked'; message: string };

export function resolveWallpaperConsentSettings(
  settings: AppSettings,
  restoreHistoricalChoices: boolean,
  cloudWallpaperReady: boolean,
): WallpaperConsentResolution {
  if (
    restoreHistoricalChoices
    && settings.wallpaper_use_cloud
    && !cloudWallpaperReady
  ) {
    return {
      kind: 'blocked',
      message: '历史设置选择了云端壁纸。请先完成登录、Stats v2 验证和首次同步；授权仍保持暂停。',
    };
  }

  return {
    kind: 'ready',
    settings: {
      ...settings,
      wallpaper_consent_version: 1,
      wallpaper_desktop_enabled: restoreHistoricalChoices && settings.wallpaper_desktop_enabled,
      wallpaper_lockscreen_enabled: restoreHistoricalChoices && settings.wallpaper_lockscreen_enabled,
      wallpaper_dynamic_bg_enabled: restoreHistoricalChoices && settings.wallpaper_dynamic_bg_enabled,
      wallpaper_use_cloud: restoreHistoricalChoices && settings.wallpaper_use_cloud,
    },
  };
}

const CLOUD_FAILURE_LABELS: Record<CloudFailureKind, string> = {
  'session-expired': '登录状态已过期',
  'capability-missing': '云端版本不兼容',
  offline: '网络连接中断',
  permission: '云端权限不足',
  'range-unsupported': '云端范围受限',
  service: '云端服务暂不可用',
};

/**
 * Rust 只把 HTTP 状态码带出来，不带响应体（`CloudRpcFailureKind::Http`、`supabase_api_error`）。
 * 401 是会话失效，403 是权限不足，408 按网络超时，429 与 5xx 是云端暂时不可用；其余 4xx 由调用处给默认
 * 种类：RPC 层是请求与云端函数签名对不上（云端版本不兼容），Auth 刷新层沿用原来的「云端服务暂不可用」。
 */
function cloudHttpStatusKind(status: number, otherClientError: CloudFailureKind): CloudFailureKind {
  if (status === 401) return 'session-expired';
  if (status === 403) return 'permission';
  if (status === 408) return 'offline';
  if (status === 429 || status >= 500) return 'service';
  return otherClientError;
}

type RustCloudFailureRule = readonly [
  pattern: RegExp,
  kind: CloudFailureKind | ((match: RegExpExecArray) => CloudFailureKind),
];

/**
 * 桌面 Rust 端交给前端的云端错误原文（src-tauri/src/commands/mod.rs），逐句归类（T10.200，root R-60）。
 * 映射表与每条的理由见 docs/task-logs/T10.200/ 的实现日志。frontend-contracts「cloud recovery
 * distinguishes…」从 Rust 源码里读出这些原文逐条核对，Rust 改了措辞而这里没跟上时测试变红，
 * 不会悄悄落进最后的关键词兜底。
 */
const RUST_CLOUD_FAILURE_RULES: readonly RustCloudFailureRule[] = [
  // CloudRpcFailure::safe_message
  [/Cloud capability '[^']*' is unavailable\./, 'capability-missing'], // MissingSignature
  // CUSTOM_RANGE_CLOUD_UNSUPPORTED：旧服务器（v2 签名缺失，或有签名但未跑日期迁移）诚实降级的统一措辞，
  // 不是云端服务故障，不能归入「云端服务暂不可用」（T10.180、T10.185）。
  [/暂不支持自定义日期范围/, 'range-unsupported'],
  // AuthRequired：Rust 把 HTTP 401 与 403 合成这一句（classify_cloud_rpc_failure），前端分不出是哪一个；
  // 原文要求重新登录，看板能做的也只有重新登录。
  [/Cloud session is not authorized\. Please sign in again\./, 'session-expired'],
  [/Cloud RPC request failed \(HTTP (\d{3})\)\./, (match) => cloudHttpStatusKind(Number(match[1]), 'capability-missing')],
  [/Cloud RPC request could not be completed\./, 'offline'], // Transport
  // Superseded：请求途中会话换了代（刷新、登录或退出），不是登录过期；重试会用新会话，
  // 若其实是退出，重试会得到「Please sign in to Supabase first.」再走重新登录。
  [/Cloud RPC request was superseded by a newer session state\./, 'service'],
  [/Cloud RPC returned an invalid response\./, 'service'], // InvalidResponse：2xx 但响应体不是 JSON
  // 看板取数的外层包装与响应校验
  [/Cloud dashboard does not support the requested multi-filter\/search query: /, 'capability-missing'],
  [/Cloud Stats v2 response .*echo/, 'capability-missing'],
  [/cloud RPC returned a non-object response|cloud dashboard response is invalid/, 'capability-missing'],
  [/Cloud client unavailable: /, 'service'],
  // 会话刷新与会话闸门（refresh_session_if_needed_with_lease、perform_session_refresh、CloudSessionCoordinator）
  [/Please sign in to Supabase first\./, 'session-expired'],
  [/Please configure Supabase URL and publishable key first\./, 'session-expired'],
  [/Supabase session expired\. Please sign in again\./, 'session-expired'],
  [/Supabase API request failed \(HTTP (\d{3})\)\./, (match) => cloudHttpStatusKind(Number(match[1]), 'service')],
  [/Supabase session refresh failed \[(connect|timeout|network|other)\]: /, (match) => (match[1] === 'other' ? 'service' : 'offline')],
  [/Supabase session refresh client unavailable: /, 'service'],
  [/Invalid Supabase refresh response\./, 'service'],
  [/Supabase session operation was superseded\./, 'service'],
  [/Supabase session refresh was interrupted\./, 'service'],
  [/Supabase session use is blocked until sign-out cleanup completes\./, 'session-expired'],
  // 本机安全存储（钥匙串与会话闸门文件）：这台设备上存着的登录暂时用不了，看板能给的出路是重新登录
  // （先退出再到云端设置登录）。是否另设一类并改给「去设置」的状态检查，列给 root 决定。
  [/stored Supabase session is invalid: /, 'session-expired'],
  [/failed to (?:read Supabase session from|migrate legacy Supabase session in|store Supabase session in|clear Supabase session from) keyring: /, 'session-expired'],
  [/system keyring unavailable: |system keyring read is blocked until an explicit status retry\./, 'session-expired'],
  [/Unable to (?:read|save) cloud session (?:keyring )?safety state\.|Unable to (?:acquire|release) cloud session safety lock\.|Cloud session safety epoch is exhausted\./, 'session-expired'],
];

function describeCloudFailure(kind: CloudFailureKind, message: string): CloudFailureDescription {
  return { kind, label: CLOUD_FAILURE_LABELS[kind], message };
}

/**
 * Keep cloud recovery language stable across the dashboard and onboarding.
 * Classification only changes presentation; native errors remain available in
 * the detailed message. Order: an already labelled text (「标签：原文」, as
 * useStats writes it) keeps its kind, then the exact Rust messages above, then
 * the conservative keyword fallback for everything else (PostgREST text,
 * browser fetch errors, front-end checks).
 */
export function classifyCloudFailure(value: unknown): CloudFailureDescription {
  const message = value instanceof Error ? value.message : String(value ?? '');
  for (const [kind, label] of Object.entries(CLOUD_FAILURE_LABELS) as Array<[CloudFailureKind, string]>) {
    if (message.startsWith(`${label}：`)) return describeCloudFailure(kind, message.slice(label.length + 1));
  }
  for (const [pattern, kind] of RUST_CLOUD_FAILURE_RULES) {
    const match = pattern.exec(message);
    if (match) return describeCloudFailure(typeof kind === 'function' ? kind(match) : kind, message);
  }
  const normalized = message.toLowerCase();
  if (
    normalized.includes('jwt')
    || normalized.includes('session')
    || normalized.includes('401')
    || normalized.includes('not authenticated')
    || normalized.includes('auth-required')
  ) {
    return describeCloudFailure('session-expired', message);
  }
  if (
    normalized.includes('stats v2')
    || normalized.includes('rpc')
    || normalized.includes('migration')
    || (normalized.includes('function') && normalized.includes('not exist'))
  ) {
    return describeCloudFailure('capability-missing', message);
  }
  if (
    normalized.includes('network')
    || normalized.includes('offline')
    || normalized.includes('timed out')
    || normalized.includes('timeout')
    || normalized.includes('dns')
    || normalized.includes('fetch')
  ) {
    return describeCloudFailure('offline', message);
  }
  if (normalized.includes('403') || normalized.includes('permission') || normalized.includes('rls')) {
    return describeCloudFailure('permission', message);
  }
  return describeCloudFailure('service', message);
}

export function validateCloudConnectionConfig(
  config: { supabase_url: string; supabase_key: string },
): string | null {
  const rawUrl = config.supabase_url.trim();
  const key = config.supabase_key.trim();
  if (!rawUrl) return '请输入 Supabase Project URL';
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'Project URL 格式无效';
  }
  const localHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(localHost && url.protocol === 'http:')) {
    return 'Project URL 必须使用 HTTPS（本机开发环境除外）';
  }
  if (!key) return '请输入 publishable key 或旧版 anon key';
  const normalizedKey = key.toLowerCase();
  let jwtRole = '';
  const jwtParts = key.split('.');
  if (jwtParts.length === 3) {
    try {
      const encodedPayload = jwtParts[1].replace(/-/g, '+').replace(/_/g, '/');
      const paddedPayload = encodedPayload.padEnd(
        encodedPayload.length + ((4 - (encodedPayload.length % 4)) % 4),
        '=',
      );
      const payload = JSON.parse(globalThis.atob(paddedPayload)) as { role?: unknown };
      if (typeof payload.role === 'string') jwtRole = payload.role.toLowerCase();
    } catch {
      // A malformed JWT is handled by the generic key validation/backend.
    }
  }
  if (
    normalizedKey.startsWith('sb_secret_')
    || normalizedKey.includes('service_role')
    || normalizedKey.includes('service-role')
    || jwtRole === 'service_role'
  ) {
    return '不能使用 secret/service role key，请改用 publishable key';
  }
  if (key.length < 20) return '公开密钥长度异常，请重新复制完整 key';
  return null;
}

export function validateCloudCredentials(email: string, password: string): string | null {
  const normalizedEmail = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return '请输入有效邮箱地址';
  if (!password) return '请输入密码';
  return null;
}

export function isStatsV2Capable(stats: Pick<StatsData, 'meta'> | null | undefined): boolean {
  return (stats?.meta?.contractVersion ?? 0) >= 2;
}

export function isSuccessfulCloudSyncResult(value: unknown): value is SuccessfulCloudSyncResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return result.success === true
    && typeof result.message === 'string'
    && result.message.trim().length > 0
    && (
      result.warning === undefined
      || result.warning === null
      || (typeof result.warning === 'string' && result.warning.trim().length === 0)
    );
}
