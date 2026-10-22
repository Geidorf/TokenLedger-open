import type { QuotaProviderEnvelope, QuotaWindowSnapshot } from '../types';
import {
  quotaStatusAllowsValues,
  validateQuotaWindowTimeline,
  validateQuotaWindowValues,
} from './contracts/quota';

/**
 * 额度可用等级：只用于着色与摘要排序，不改变任何数值。阈值与壁纸/Android 的
 * 琥珀/危险语义一致：低于 20% 视为紧张，20–49% 为提醒，其余为正常。
 */
export type QuotaLevel = 'ok' | 'warn' | 'critical';

const PROVIDER_DISPLAY_LABELS: Record<string, string> = {
  'openai-codex-local': 'Codex',
  'anthropic-claude-consumer': 'Claude',
  'google-antigravity-consumer': 'Antigravity',
};

/**
 * 来源在界面上的短名。看板、挂件与设置页必须叫同一个名字——用户在设置里钉住
 * 「Claude」，挂件上就得写「Claude」。
 */
export function providerDisplayName(
  provider: Pick<QuotaProviderEnvelope, 'providerId' | 'displayName'> & Partial<Pick<QuotaProviderEnvelope, 'scope'>>,
): string {
  return PROVIDER_DISPLAY_LABELS[provider.providerId]
    || (provider.scope === 'manual-budget' ? '手动预算' : provider.displayName);
}

export function quotaLevel(remainingPercent: number): QuotaLevel {
  if (!Number.isFinite(remainingPercent) || remainingPercent < 20) return 'critical';
  if (remainingPercent < 50) return 'warn';
  return 'ok';
}

export interface QuotaWindowReading {
  /** 已四舍五入的可用百分比 0–100。 */
  remaining: number;
  /** 窗口按观测时间与重置时间推算后的有效状态。 */
  status: 'ok' | 'stale';
  resetsAt?: string;
}

/**
 * 只对来源直接给出百分比、且时间线可信的窗口给出读数；绝对余额、unlimited、
 * 错误与需授权的窗口返回 null——摘要与仪表一样不构造虚假进度。
 */
export function readQuotaWindow(window: QuotaWindowSnapshot, now: number): QuotaWindowReading | null {
  if (!quotaStatusAllowsValues(window.status)) return null;
  const values = validateQuotaWindowValues(window);
  if (!values || values.kind !== 'percent' || !validateQuotaWindowTimeline(window)) return null;
  const observedAt = new Date(window.observedAt).getTime();
  const resetsAt = window.resetsAt ? new Date(window.resetsAt).getTime() : Number.NaN;
  const staleByAge = now >= observedAt + window.staleAfterSeconds * 1_000;
  const staleByReset = Number.isFinite(resetsAt) && resetsAt <= now;
  const status: 'ok' | 'stale' = window.status === 'stale' || staleByAge || staleByReset ? 'stale' : 'ok';
  return {
    remaining: Math.max(0, Math.min(100, 100 - Math.round(values.used))),
    status,
    resetsAt: window.resetsAt,
  };
}

export interface QuotaWindowHighlight extends QuotaWindowReading {
  providerId: string;
  providerName: string;
  windowId: string;
  windowLabel: string;
  level: QuotaLevel;
}

interface HighlightLabels {
  providerName: (provider: QuotaProviderEnvelope) => string;
  windowLabel: (window: QuotaWindowSnapshot, provider: QuotaProviderEnvelope) => string | null;
}

/**
 * 收集全部可读窗口并按"可用比例升序、同比例时重置更早者优先"排序。
 * 第一项即"最紧额度"。窗口标签由调用方提供，避免与展示层互相依赖。
 */
export function collectQuotaHighlights(
  providers: readonly QuotaProviderEnvelope[],
  now: number,
  labels: HighlightLabels,
): QuotaWindowHighlight[] {
  const highlights: QuotaWindowHighlight[] = [];
  for (const provider of providers) {
    if (provider.status !== 'ok' && provider.status !== 'stale') continue;
    for (const window of provider.windows) {
      const reading = readQuotaWindow(window, now);
      if (!reading) continue;
      const windowLabel = labels.windowLabel(window, provider);
      if (!windowLabel) continue;
      highlights.push({
        ...reading,
        providerId: provider.providerId,
        providerName: labels.providerName(provider),
        windowId: window.windowId,
        windowLabel,
        level: quotaLevel(reading.remaining),
      });
    }
  }
  return highlights.sort((left, right) => {
    if (left.remaining !== right.remaining) return left.remaining - right.remaining;
    const leftReset = left.resetsAt ? new Date(left.resetsAt).getTime() : Number.POSITIVE_INFINITY;
    const rightReset = right.resetsAt ? new Date(right.resetsAt).getTime() : Number.POSITIVE_INFINITY;
    if (leftReset !== rightReset) return leftReset - rightReset;
    return `${left.providerId}:${left.windowId}`.localeCompare(`${right.providerId}:${right.windowId}`);
  });
}

export interface QuotaHighlightSummary {
  count: number;
  averageRemaining: number | null;
  critical: number;
  stale: number;
}

export function summarizeQuotaHighlights(highlights: readonly QuotaWindowHighlight[]): QuotaHighlightSummary {
  if (highlights.length === 0) {
    return { count: 0, averageRemaining: null, critical: 0, stale: 0 };
  }
  const total = highlights.reduce((sum, item) => sum + item.remaining, 0);
  return {
    count: highlights.length,
    averageRemaining: Math.round(total / highlights.length),
    critical: highlights.filter((item) => item.level === 'critical').length,
    stale: highlights.filter((item) => item.status === 'stale').length,
  };
}
