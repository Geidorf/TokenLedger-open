import type { QuotaProviderEnvelope } from '../types';

export const QUOTA_RESET_REFRESH_GRACE_MS = 5_000;
export const MAX_QUOTA_RESET_TIMER_MS = 2_147_483_647;

const RFC3339_WITH_TIMEZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/i;

export interface QuotaResetSchedule {
  key: string;
  resetAt: number;
  refreshAt: number;
}

function parseResetAt(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = RFC3339_WITH_TIMEZONE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const utc = match[8].toUpperCase() === 'Z';
  const offsetHour = utc ? 0 : Number(match[9]);
  const offsetMinute = utc ? 0 : Number(match[10]);
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
  ) return null;
  const fraction = match[7] ? `.${match[7].slice(0, 3).padEnd(3, '0')}` : '';
  const timezone = utc ? 'Z' : match[8];
  const timestamp = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${fraction}${timezone}`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function quotaResetSchedules(
  providers: readonly QuotaProviderEnvelope[],
  graceMs = QUOTA_RESET_REFRESH_GRACE_MS,
): QuotaResetSchedule[] {
  const schedules = new Map<string, QuotaResetSchedule>();
  for (const provider of providers) {
    for (const window of provider.windows) {
      const resetAt = parseResetAt(window.resetsAt);
      if (resetAt === null || !Number.isFinite(graceMs) || graceMs < 0) continue;
      const key = JSON.stringify([provider.providerId, provider.scope, window.windowId, window.resetsAt]);
      schedules.set(key, { key, resetAt, refreshAt: resetAt + graceMs });
    }
  }
  return [...schedules.values()].sort((left, right) => left.refreshAt - right.refreshAt || left.key.localeCompare(right.key));
}

export function nextQuotaResetTimerDelay(refreshAt: number, now: number): number {
  if (!Number.isFinite(refreshAt) || !Number.isFinite(now)) return MAX_QUOTA_RESET_TIMER_MS;
  return Math.min(MAX_QUOTA_RESET_TIMER_MS, Math.max(0, refreshAt - now));
}
