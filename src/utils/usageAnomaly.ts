import { formatEstimatedUsd, formatTokens } from './format';
import { toolDisplayName } from './toolDisplayName';
import { localized, t } from '../i18n';

/**
 * 用量异常检测（`src-tauri/src/usage_anomaly.rs`）的读数与文案。只看本机已经发生的用量：
 * 最近一个桶与它之前一段时间的中位数比，不做外推。规则写在 `RULE_TEXT`，界面原样展示，
 * 让用户知道为什么被标出。
 */
export const ANOMALY_KINDS = [
  'tokenSpike',
  'costSpike',
  'cacheHitDrop',
  'toolSurge',
  'modelSurge',
  'expensiveSession',
  'gatewayErrors',
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];
export type AnomalyGranularity = 'hour' | 'day' | 'session';
export type AnomalyUnit = 'tokens' | 'usd' | 'rate';
export type AnomalyCheckState = 'evaluated' | 'insufficientBaseline' | 'unavailable';

export interface AnomalyFinding {
  id: string;
  kind: AnomalyKind;
  granularity: AnomalyGranularity;
  bucket: string;
  subject: string | null;
  tool: string | null;
  value: number;
  baseline: number;
  ratio: number | null;
  unit: AnomalyUnit;
  inProgress: boolean;
  sample: number | null;
}

export interface AnomalyReport {
  generatedAt: string;
  baselineDays: number;
  recentDays: number;
  recentHours: number;
  findings: AnomalyFinding[];
  checks: { kind: AnomalyKind; state: AnomalyCheckState }[];
}

export interface AnomalySettings {
  notify: boolean;
}

export const KIND_LABELS = localized<AnomalyKind>({
  tokenSpike: 'usageAnomaly.kind.tokenSpike',
  costSpike: 'usageAnomaly.kind.costSpike',
  cacheHitDrop: 'usageAnomaly.kind.cacheHitDrop',
  toolSurge: 'usageAnomaly.kind.toolSurge',
  modelSurge: 'usageAnomaly.kind.modelSurge',
  expensiveSession: 'usageAnomaly.kind.expensiveSession',
  gatewayErrors: 'usageAnomaly.kind.gatewayErrors',
});

/** 每条规则的判定口径，与 Rust 常量一致；改阈值时两边一起改（文案在 i18n 的 `usageAnomaly.rule.*`）。 */
export const RULE_TEXT = localized<AnomalyKind>({
  tokenSpike: 'usageAnomaly.rule.tokenSpike',
  costSpike: 'usageAnomaly.rule.costSpike',
  cacheHitDrop: 'usageAnomaly.rule.cacheHitDrop',
  toolSurge: 'usageAnomaly.rule.toolSurge',
  modelSurge: 'usageAnomaly.rule.modelSurge',
  expensiveSession: 'usageAnomaly.rule.expensiveSession',
  gatewayErrors: 'usageAnomaly.rule.gatewayErrors',
});

export const CHECK_STATE_TEXT = localized<Exclude<AnomalyCheckState, 'evaluated'>>({
  insufficientBaseline: 'usageAnomaly.checkState.insufficientBaseline',
  unavailable: 'usageAnomaly.checkState.unavailable',
});

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | null =>
  typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null;

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

function parseFinding(value: unknown): AnomalyFinding | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const kind = oneOf(ANOMALY_KINDS, record.kind);
  const granularity = oneOf(['hour', 'day', 'session'] as const, record.granularity);
  const unit = oneOf(['tokens', 'usd', 'rate'] as const, record.unit);
  const findingValue = finite(record.value);
  const baseline = finite(record.baseline);
  if (!kind || !granularity || !unit || typeof record.id !== 'string' || typeof record.bucket !== 'string'
    || findingValue === null || baseline === null) {
    return null;
  }
  return {
    id: record.id,
    kind,
    granularity,
    bucket: record.bucket,
    subject: text(record.subject),
    tool: text(record.tool),
    value: findingValue,
    baseline,
    ratio: finite(record.ratio),
    unit,
    inProgress: record.inProgress === true,
    sample: finite(record.sample),
  };
}

export function parseAnomalyReport(value: unknown): AnomalyReport | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.findings) || !Array.isArray(record.checks)) return null;
  return {
    generatedAt: typeof record.generatedAt === 'string' ? record.generatedAt : '',
    baselineDays: finite(record.baselineDays) ?? 14,
    recentDays: finite(record.recentDays) ?? 7,
    recentHours: finite(record.recentHours) ?? 24,
    findings: record.findings.map(parseFinding).filter((item): item is AnomalyFinding => item !== null),
    checks: record.checks.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const check = item as Record<string, unknown>;
      const kind = oneOf(ANOMALY_KINDS, check.kind);
      const state = oneOf(['evaluated', 'insufficientBaseline', 'unavailable'] as const, check.state);
      return kind && state ? [{ kind, state }] : [];
    }),
  };
}

export function parseAnomalySettings(value: unknown): AnomalySettings {
  return { notify: Boolean(value && typeof value === 'object' && (value as { notify?: unknown }).notify === true) };
}

function formatValue(value: number, unit: AnomalyUnit): string {
  if (unit === 'usd') return formatEstimatedUsd(value);
  if (unit === 'rate') return `${(value * 100).toFixed(1)}%`;
  return t('usageAnomaly.value.tokens', { tokens: formatTokens(value) });
}

/** `2026-10-24 15:00` → `今天 15:00`；`2026-10-23` → `昨天`；更早的保留 `10-21`（随界面语言）。 */
export function bucketLabel(finding: Pick<AnomalyFinding, 'bucket' | 'granularity'>, today: Date = new Date()): string {
  const date = finding.bucket.slice(0, 10);
  const iso = (offset: number) => {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  };
  const dayText = date === iso(0) ? t('usageAnomaly.today') : date === iso(1) ? t('usageAnomaly.yesterday') : date.slice(5);
  if (finding.granularity === 'hour') return `${dayText} ${finding.bucket.slice(11, 16)}`;
  if (finding.granularity === 'session') return t('usageAnomaly.recentActive', { day: dayText });
  return dayText;
}

export interface FindingCopy {
  title: string;
  when: string;
  value: string;
  comparison: string;
}

/** 一条异常的卡片文案：是什么、何时、多少、和平时比如何。 */
export function describeFinding(finding: AnomalyFinding, today: Date = new Date()): FindingCopy {
  const subject = finding.kind === 'toolSurge' || finding.kind === 'expensiveSession'
    ? toolDisplayName(finding.tool ?? finding.subject ?? '')
    : finding.subject ?? '';
  const title = finding.kind === 'toolSurge' || finding.kind === 'modelSurge'
    ? t('usageAnomaly.title.surge', { subject })
    : finding.kind === 'expensiveSession'
      ? t('usageAnomaly.title.expensiveSession', { subject })
      : KIND_LABELS[finding.kind];
  const baseline = formatValue(finding.baseline, finding.unit);
  let comparison: string;
  if (finding.kind === 'cacheHitDrop') {
    comparison = t('usageAnomaly.comparison.rateDrop', { baseline, points: ((finding.baseline - finding.value) * 100).toFixed(1) });
  } else if (finding.kind === 'gatewayErrors') {
    comparison = t('usageAnomaly.comparison.gateway', { count: finding.sample ?? 0, baseline });
  } else {
    const usual = finding.kind === 'expensiveSession' ? 'usageAnomaly.comparison.session' : finding.granularity === 'hour' ? 'usageAnomaly.comparison.hour' : 'usageAnomaly.comparison.day';
    comparison = t(usual, { baseline }) + (finding.ratio !== null ? t('usageAnomaly.comparison.ratio', { ratio: `${finding.ratio}×` }) : '');
  }
  const label = bucketLabel(finding, today);
  const when = finding.inProgress ? t('usageAnomaly.when.inProgress', { when: label }) : label;
  return { title, when, value: formatValue(finding.value, finding.unit), comparison };
}

/** 能下钻到某天明细的异常：小时与天按日期，Agent / 模型放量带上实体筛选。 */
export function findingDrill(finding: AnomalyFinding): { date: string; tools: string[]; models: string[] } | null {
  if (finding.granularity === 'session') return null;
  const date = finding.bucket.slice(0, 10);
  if (finding.kind === 'gatewayErrors') return null;
  return {
    date,
    tools: finding.kind === 'toolSurge' && finding.subject ? [finding.subject] : [],
    models: finding.kind === 'modelSurge' && finding.subject ? [finding.subject] : [],
  };
}
