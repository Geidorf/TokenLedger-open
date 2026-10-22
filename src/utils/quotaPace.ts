/**
 * 额度消耗速度（pace）的纯规则层（T10.153，用户决定 D2 / D4）。规格见
 * docs/design/forecast-and-pace-v1.md。
 *
 * 只读 Quota v1 envelope 已有字段：百分比窗口的已用比例、windowMinutes、resetsAt、
 * observedAt 与新鲜度；不从 Stats、费用或活动量推导额度（quota-provider-v1 §7），也不写回
 * envelope、LKG 或同步投影。上游桥接自带的 pace 字段仍按契约丢弃，这里只用自己的公式。
 *
 * 方法：窗口起点 = resetsAt − windowMinutes；“照此速度”指窗口开始到观测时刻的平均速度，
 * 重置时用量 = 已用% × 窗口时长 ÷ 已过时长。观测区间 [窗口起点, observedAt] 是已经完整
 * 发生的一段，外推只用它，且必须已过足够长（刚重置时不外推，更不从零时长外推）。
 *
 * reset 精度默认不信任：来源没有声明精度时，从时间戳推断最粗的可能精度（Claude CLI 的
 * “Resets in 4 days”换算出的 reset 恰好是观测时刻加整天），超过窗口时长 5% 就不预测。
 * 来源能力必须给出：experimental 来源（窗口时长或 reset 由推断得到）一律不预测。
 *
 * 状态与 D4 对齐（剩余 <20% 告急、<50% 偏紧 描述的是“当前”剩余，由 quotaLevel 负责）：
 * - critical：照此速度会在重置前用完（含已经用完）；
 * - tight：照此速度重置前会跌进 D4 告急区（剩余 <20%）；当前已在告急区的窗口因此至少是 tight；
 * - ok：照此速度重置时仍剩 20% 以上。
 * 区间不是概率区间：单次观测无法估计波动，这里给出“剩余时间放慢一半到加快一半”的敏感度范围。
 */
import type { QuotaProviderEnvelope, QuotaWindowSnapshot } from '../types';
import {
  quotaStatusAllowsValues,
  validateQuotaWindowTimeline,
  validateQuotaWindowValues,
} from './contracts/quota';
import { quotaLevel, readQuotaWindow, type QuotaLevel } from './quotaOverview';

export type QuotaPaceStatus = 'ok' | 'tight' | 'critical' | 'insufficient' | 'stale' | 'unsupported';

export type QuotaPaceReason =
  /** 窗口状态不带数值（auth-required / error），或数值未通过契约校验。 */
  | 'values-unavailable'
  /** 绝对余额、Credits、unlimited：没有可验证的百分比进度。 */
  | 'not-percent'
  /** 时间字段未通过契约校验。 */
  | 'invalid-timeline'
  | 'window-length-unknown'
  | 'reset-unknown'
  /** resetsAt 精度太粗（例如只知道“4 天后”）：来源声明的，或按时间戳推断的。 */
  | 'reset-imprecise'
  /**
   * 来源能力为 experimental（例如 Antigravity 的窗口时长由桶名推断、Claude PTY 的 reset 由相对
   * 文本换算），或调用方没有给出能力：先不显示速度。
   */
  | 'provider-experimental'
  /** 观测时刻不在 [resetsAt − windowMinutes, resetsAt) 之内。 */
  | 'timeline-inconsistent'
  | 'observation-stale'
  | 'reset-elapsed'
  | 'too-early';

export interface QuotaPace {
  /** 品牌：速度是看板上的预测，不进入同步、海报与导出。 */
  kind: 'quota-pace';
  status: QuotaPaceStatus;
  reason: QuotaPaceReason | null;
  /** 观测时的已用百分比（未取整）。 */
  usedPercent: number | null;
  /** 当前剩余按 D4 的等级，与额度条颜色同源。 */
  currentLevel: QuotaLevel | null;
  windowStartAt: number | null;
  resetsAt: number | null;
  observedAt: number | null;
  /** 观测时窗口已过的比例，(0, 1]。 */
  elapsedFraction: number | null;
  /** 照此速度到重置时的用量，未封顶，可超过 100。 */
  projectedDemandPercent: number | null;
  /** 展示用：封顶 100。 */
  projectedUsedAtReset: number | null;
  /** 剩余时间放慢一半 / 加快一半时的重置时用量，封顶 100。 */
  projectedRange: { low: number; high: number } | null;
  willExhaustBeforeReset: boolean | null;
  exhausted: boolean;
  /** 照此速度用完的时刻（epoch ms），只在重置前会用完时给出。 */
  exhaustsAt: number | null;
  /**
   * 只在 critical（照此速度会在重置前用完）时给出：加快一半时最早用完的时刻；放慢一半仍在
   * 重置前用完时给出最晚时刻，否则 latest 为 null（放慢一半可撑到重置）。ok / tight 时为 null。
   */
  exhaustsAtRange: { earliest: number; latest: number | null } | null;
  /** 允许外推前窗口至少要过去的时长。 */
  minElapsedMs: number | null;
  /** 本次判定采用的 reset 精度（秒）：来源声明的值，或按时间戳推断的最粗精度（0 表示细于整分钟）。 */
  resetPrecisionSeconds: number | null;
}

export interface QuotaPaceOptions {
  /**
   * 必填：窗口所属 envelope 的 `capability`。只有 stable 与 plan-dependent 来源计算速度；
   * experimental（以及绕过类型检查漏传的未知能力）返回 `provider-experimental`。
   */
  providerCapability: QuotaProviderEnvelope['capability'];
  /**
   * 来源声明的 resetsAt 精度（秒），优先于推断；非有限值或负数视为不可信。契约加入
   * `resetsAtPrecisionSeconds` 之前，缺省时按 `inferResetPrecisionSeconds` 从时间戳推断，
   * 不再缺省当作精确。
   */
  resetPrecisionSeconds?: number;
}

/** 可以计算速度的来源能力：manual 预算窗口不是百分比，会先被 not-percent 拦下。 */
const PACE_TRUSTED_CAPABILITIES: ReadonlySet<string> = new Set(['stable', 'plan-dependent', 'manual']);

/** D4 告急线：照此速度重置前会跌破它即为偏紧。 */
export const PACE_TIGHT_REMAINING_PERCENT = 20;
/** 至少过去窗口的 10% 才外推。 */
export const PACE_MIN_ELAPSED_FRACTION = 0.1;
/** 多日窗口至少过去一整天，覆盖一次作息周期。 */
export const PACE_MULTI_DAY_MIN_ELAPSED_MINUTES = 1_440;
/** 敏感度范围：剩余时间速度为平均的 0.5–1.5 倍。 */
export const PACE_RATE_BAND = { slower: 0.5, faster: 1.5 } as const;
/** resetsAt 误差超过窗口时长的 5% 时不预测。 */
export const PACE_MAX_RESET_PRECISION_FRACTION = 0.05;
/** 推断精度时依次检查的单位（秒）：整天、整小时、整分钟。 */
const RESET_PRECISION_UNITS_SECONDS = [86_400, 3_600, 60] as const;

const MINUTE_MS = 60_000;
const TIMELINE_TOLERANCE_MIN_MS = 5 * MINUTE_MS;
const TIMELINE_TOLERANCE_FRACTION = 0.01;

const RFC3339 = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i;

/** 与 contracts/quota.ts 相同的规范化：小数秒截到毫秒，保证 V8 与 JavaScriptCore 解析一致。 */
function parseTimestamp(value: string | undefined): number | null {
  if (typeof value !== 'string') return null;
  const match = RFC3339.exec(value);
  if (!match) return null;
  const fraction = match[3] ? `.${match[3].slice(0, 3).padEnd(3, '0')}` : '';
  const zone = match[4].toUpperCase() === 'Z' ? 'Z' : match[4];
  const timestamp = Date.parse(`${match[1]}T${match[2]}${fraction}${zone}`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * 从时间戳推断 resetsAt 的最粗可能精度（秒）。相对时间来源按观测（或抓取）时刻加整天 / 整小时 /
 * 整分钟换算 reset，差值恰为该单位的整数倍；精确来源恰好落在整天上的概率约为 1/86400，误判的
 * 代价只是这一次不显示速度。精度未知时按最粗的可能处理，不当作精确。返回 86400、3600、60，
 * 或 0（与所有基准时刻的差都不是整分钟）。
 */
export function inferResetPrecisionSeconds(resetsAt: number, bases: readonly number[]): number {
  let coarsest = 0;
  for (const base of bases) {
    const difference = resetsAt - base;
    if (!Number.isFinite(difference) || difference <= 0) continue;
    const unit = RESET_PRECISION_UNITS_SECONDS.find((seconds) => difference % (seconds * 1_000) === 0);
    if (unit !== undefined) coarsest = Math.max(coarsest, unit);
  }
  return coarsest;
}

function emptyPace(status: QuotaPaceStatus, reason: QuotaPaceReason | null): QuotaPace {
  return {
    kind: 'quota-pace',
    status,
    reason,
    usedPercent: null,
    currentLevel: null,
    windowStartAt: null,
    resetsAt: null,
    observedAt: null,
    elapsedFraction: null,
    projectedDemandPercent: null,
    projectedUsedAtReset: null,
    projectedRange: null,
    willExhaustBeforeReset: null,
    exhausted: false,
    exhaustsAt: null,
    exhaustsAtRange: null,
    minElapsedMs: null,
    resetPrecisionSeconds: null,
  };
}

/**
 * 计算单个额度窗口的消耗速度。`now` 为 epoch 毫秒，只用于判断新鲜度与重置是否已过；
 * 速度本身按观测时刻计算，因为已用比例对应的是 observedAt。
 */
export function computeQuotaPace(
  window: QuotaWindowSnapshot,
  now: number,
  options: QuotaPaceOptions,
): QuotaPace {
  if (!quotaStatusAllowsValues(window.status)) return emptyPace('unsupported', 'values-unavailable');
  const values = validateQuotaWindowValues(window);
  if (!values) return emptyPace('unsupported', 'values-unavailable');
  if (values.kind !== 'percent') return emptyPace('unsupported', 'not-percent');
  // 能力未知不当作可信：绕过类型检查漏传 options 时同样不预测。
  const capability: unknown = (options as Partial<QuotaPaceOptions> | undefined)?.providerCapability;
  if (typeof capability !== 'string' || !PACE_TRUSTED_CAPABILITIES.has(capability)) {
    return emptyPace('unsupported', 'provider-experimental');
  }
  if (!Number.isFinite(now) || !validateQuotaWindowTimeline(window)) {
    return emptyPace('unsupported', 'invalid-timeline');
  }

  const used = values.used;
  const reading = readQuotaWindow(window, now);
  const observedAt = parseTimestamp(window.observedAt);
  if (!reading || observedAt === null) return emptyPace('unsupported', 'invalid-timeline');
  const known = {
    usedPercent: used,
    currentLevel: quotaLevel(reading.remaining),
    observedAt,
  };

  if (window.windowMinutes === undefined) {
    return { ...emptyPace('unsupported', 'window-length-unknown'), ...known };
  }
  const resetsAt = parseTimestamp(window.resetsAt);
  if (resetsAt === null) return { ...emptyPace('unsupported', 'reset-unknown'), ...known };

  const windowMs = window.windowMinutes * MINUTE_MS;
  // 精度未知时不当作精确：按观测与抓取时刻推断最粗的可能精度（相对时间来源的 reset 恰好差整天 / 整小时）。
  const declared = options.resetPrecisionSeconds;
  const fetchedAt = parseTimestamp(window.fetchedAt);
  const precision = declared ?? inferResetPrecisionSeconds(resetsAt, fetchedAt === null ? [observedAt] : [observedAt, fetchedAt]);
  if (!Number.isFinite(precision) || precision < 0) {
    return { ...emptyPace('unsupported', 'reset-imprecise'), ...known, resetsAt };
  }
  const withReset = { ...known, resetsAt, resetPrecisionSeconds: precision };
  if (precision * 1_000 > PACE_MAX_RESET_PRECISION_FRACTION * windowMs) {
    return { ...emptyPace('unsupported', 'reset-imprecise'), ...withReset };
  }

  // 新鲜度与额度面板同源（readQuotaWindow）：来源标 stale、超过 staleAfterSeconds 或 reset 已过。
  if (reading.status === 'stale') {
    return { ...emptyPace('stale', resetsAt <= now ? 'reset-elapsed' : 'observation-stale'), ...withReset };
  }

  const windowStartAt = resetsAt - windowMs;
  const tolerance = Math.max(TIMELINE_TOLERANCE_MIN_MS, TIMELINE_TOLERANCE_FRACTION * windowMs);
  if (observedAt >= resetsAt || observedAt < windowStartAt - tolerance) {
    return { ...emptyPace('unsupported', 'timeline-inconsistent'), ...withReset };
  }
  const elapsedMs = Math.max(0, observedAt - windowStartAt);
  const minElapsedMs = Math.max(
    PACE_MIN_ELAPSED_FRACTION * windowMs,
    window.windowMinutes > PACE_MULTI_DAY_MIN_ELAPSED_MINUTES ? PACE_MULTI_DAY_MIN_ELAPSED_MINUTES * MINUTE_MS : 0,
  );
  const timeline = {
    ...withReset,
    windowStartAt,
    elapsedFraction: Math.min(1, elapsedMs / windowMs),
    minElapsedMs,
  };

  if (used >= 100) {
    // 已经用完不需要外推：无论窗口过去多久都直接告急。
    return {
      ...emptyPace('critical', null),
      ...timeline,
      projectedUsedAtReset: 100,
      projectedRange: { low: 100, high: 100 },
      willExhaustBeforeReset: true,
      exhausted: true,
      exhaustsAt: observedAt,
    };
  }
  if (elapsedMs <= 0 || elapsedMs < minElapsedMs) {
    return { ...emptyPace('insufficient', 'too-early'), ...timeline };
  }

  const rate = used / elapsedMs;
  const remainingMs = resetsAt - observedAt;
  const demand = used + rate * remainingMs;
  const slower = used + rate * PACE_RATE_BAND.slower * remainingMs;
  const faster = used + rate * PACE_RATE_BAND.faster * remainingMs;
  // 用完时刻取整到毫秒，与其它 epoch 时间同一精度。
  const exhaustionAt = (multiplier: number) => (rate > 0
    ? Math.round(observedAt + (100 - used) / (rate * multiplier))
    : Number.POSITIVE_INFINITY);
  const willExhaust = demand >= 100;
  const earliest = exhaustionAt(PACE_RATE_BAND.faster);
  const latest = exhaustionAt(PACE_RATE_BAND.slower);

  let status: QuotaPaceStatus = 'ok';
  if (willExhaust) status = 'critical';
  else if (100 - demand < PACE_TIGHT_REMAINING_PERCENT) status = 'tight';

  return {
    ...emptyPace(status, null),
    ...timeline,
    projectedDemandPercent: demand,
    projectedUsedAtReset: Math.min(100, demand),
    projectedRange: { low: Math.min(100, slower), high: Math.min(100, faster) },
    willExhaustBeforeReset: willExhaust,
    exhaustsAt: willExhaust ? Math.min(resetsAt, exhaustionAt(1)) : null,
    // 只在 critical 时给出：ok / tight 时展示“加快一半会用完”会与状态互相矛盾。
    exhaustsAtRange: willExhaust && earliest <= resetsAt
      ? { earliest, latest: latest <= resetsAt ? latest : null }
      : null,
  };
}

// ---------------------------------------------------------------------------
// 文案：「预测」标签、方法与区间一起给出（D2）。

export interface QuotaPaceCopy {
  tag: '预测';
  /** 语气只辅助着色，文字本身必须能独立表达状态。 */
  tone: 'neutral' | 'warning' | 'danger';
  text: string;
  /** 方法说明：按什么速度、基于多长的已过时间。 */
  method: string;
  /** 敏感度区间；数据不足或端点都已过去时为 null。 */
  interval: string | null;
  /** 读屏用的整句：以「预测：」开头，含结论、方法与区间。 */
  ariaLabel: string;
}

function paceCopy(tone: QuotaPaceCopy['tone'], text: string, method: string, interval: string | null): QuotaPaceCopy {
  return {
    tag: '预测',
    tone,
    text,
    method,
    interval,
    ariaLabel: `${[`预测：${text}`, method, ...(interval ? [interval] : [])].join('。')}。`,
  };
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** 粗粒度中文时长：不足 1 小时按 5 分钟、不足 10 小时按半小时、不足 1 天按小时、其余按半天。 */
export function formatPaceDuration(ms: number): string {
  const minutes = Math.max(0, ms) / MINUTE_MS;
  if (minutes < 60) return `${Math.max(5, Math.round(minutes / 5) * 5)} 分钟`;
  const hours = minutes / 60;
  if (hours < 10) return `${trimNumber(Math.round(hours * 2) / 2)} 小时`;
  if (hours < 24) return `${Math.round(hours)} 小时`;
  return `${trimNumber(Math.round((hours / 24) * 2) / 2)} 天`;
}

function percentText(value: number): string {
  return `${Math.round(value)}%`;
}

function exhaustionInterval(span: QuotaPace['exhaustsAtRange'], now: number): string | null {
  if (!span) return null;
  const latestPassed = span.latest !== null && span.latest <= now;
  if (span.earliest <= now) {
    // 端点已经过去时不再写“约 5 分钟后”：两端都过去就省略区间，主文案已说明可能用完。
    if (latestPassed) return null;
    return span.latest === null
      ? '区间：加快一半时应已用完；放慢一半可撑到重置'
      : `区间：加快一半时应已用完；放慢一半约 ${formatPaceDuration(span.latest - now)}后用完`;
  }
  return span.latest === null
    ? `区间：加快一半约 ${formatPaceDuration(span.earliest - now)}后用完；放慢一半可撑到重置`
    : `区间：约 ${formatPaceDuration(span.earliest - now)}–${formatPaceDuration(span.latest - now)}后用完`;
}

/**
 * 额度行下方的一行速度说明。无法预测（不支持、历史数据）或已经用完（额度条已说明）时返回
 * null；窗口刚开始时返回一条中性说明，界面可放入行内详情——但当前已在 D4 告急区时返回 null，
 * 红色额度条已经说明问题，“暂不计算”只会显得矛盾。文字只描述结果（用多少 / 剩多少 / 多久用完），
 * 不复用额度条的“告急 / 偏紧”等级词，避免与当前剩余的 D4 颜色互相矛盾。
 */
export function describeQuotaPace(pace: QuotaPace, now: number): QuotaPaceCopy | null {
  if (pace.status === 'unsupported' || pace.status === 'stale' || pace.exhausted) return null;
  if (pace.status === 'insufficient') {
    if (pace.currentLevel === 'critical') return null;
    return paceCopy(
      'neutral',
      '窗口刚开始，暂不计算速度',
      `窗口过去 ${formatPaceDuration(pace.minElapsedMs ?? 0)}后才按平均速度预测`,
      null,
    );
  }
  const used = pace.usedPercent as number;
  const elapsed = pace.elapsedFraction as number;
  const method = `按窗口开始以来的平均速度外推（已过 ${percentText(elapsed * 100)} 时间，已用 ${percentText(used)}）`;
  const range = pace.projectedRange as { low: number; high: number };
  if (pace.status === 'critical') {
    const exhaustsAt = pace.exhaustsAt as number;
    const text = exhaustsAt > now
      ? `照此速度约 ${formatPaceDuration(exhaustsAt - now)}后用完，早于重置`
      : '照此速度可能已经用完，等待来源刷新';
    return paceCopy('danger', text, method, exhaustionInterval(pace.exhaustsAtRange, now));
  }
  const interval = `区间：放慢一半到加快一半，重置时约用 ${percentText(range.low)}–${percentText(range.high)}`;
  if (pace.status === 'tight') {
    return paceCopy(
      'warning',
      `照此速度，重置时约剩 ${percentText(100 - (pace.projectedUsedAtReset as number))}`,
      method,
      interval,
    );
  }
  return paceCopy('neutral', `照此速度，重置时约用 ${percentText(pace.projectedUsedAtReset as number)}`, method, interval);
}
