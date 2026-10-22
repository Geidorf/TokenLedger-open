import { describe, expect, it } from 'vitest';
import completeFixture from '../../fixtures/quota-provider-v1/complete-v1.json';
import type { QuotaProviderEnvelope, QuotaWindowSnapshot } from '../types';
import {
  PACE_TIGHT_REMAINING_PERCENT,
  computeQuotaPace,
  describeQuotaPace,
  formatPaceDuration,
  inferResetPrecisionSeconds,
  type QuotaPaceOptions,
} from './quotaPace';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-24T10:00:00Z');

/** 默认路径：只给来源能力，reset 精度按时间戳推断。 */
const STABLE: QuotaPaceOptions = { providerCapability: 'stable' };
/**
 * 来源声明 reset 精确到秒。只用于 reset 恰好落在观测后整小时的用例（例如 5 小时窗口已过
 * 60 分钟时 reset 在 4 小时后），否则推断会按整小时精度拒绝预测。
 */
const DECLARED_PRECISE: QuotaPaceOptions = { providerCapability: 'stable', resetPrecisionSeconds: 1 };

/**
 * 5 小时窗口：默认在观测时已过 150 分钟（50%），观测即 now。
 * elapsedMinutes 与 used 决定速度；resetsAt 由 windowMinutes 与已过时长反推。
 */
function window(
  { used, elapsedMinutes = 150, windowMinutes = 300, observedAgoMinutes = 0, ...overrides }:
    Partial<QuotaWindowSnapshot> & { used: number; elapsedMinutes?: number; observedAgoMinutes?: number },
): QuotaWindowSnapshot {
  const observedAt = NOW - observedAgoMinutes * MINUTE;
  const resetsAt = observedAt + (windowMinutes - elapsedMinutes) * MINUTE;
  return {
    providerId: 'openai-codex-local',
    windowId: 'codex:primary',
    windowLabel: '5 小时窗口',
    scope: 'consumer-subscription',
    source: 'local-authorized',
    status: 'ok',
    used,
    limit: 100,
    remaining: 100 - used,
    unit: 'percent',
    windowMinutes,
    resetsAt: new Date(resetsAt).toISOString(),
    observedAt: new Date(observedAt).toISOString(),
    fetchedAt: new Date(observedAt).toISOString(),
    staleAfterSeconds: 900,
    ...overrides,
  };
}

/**
 * Claude 内置 CLI PTY 的形状：reset = 抓取时刻 + 解析出的相对时长（“Resets in 4 days”）。
 * 观测与抓取是同一时刻，毫秒部分随真实时钟。
 */
function claudePtyWindow(used: number, windowMinutes: number, resetsInMs: number, fetchedAt: number): QuotaWindowSnapshot {
  return {
    providerId: 'anthropic-claude-consumer',
    windowId: windowMinutes === 300 ? 'native-cli-five-hour' : 'native-cli-seven-day',
    windowLabel: windowMinutes === 300 ? '5 小时窗口' : '每周',
    scope: 'consumer-subscription',
    source: 'local-authorized',
    status: 'ok',
    used,
    limit: 100,
    remaining: 100 - used,
    unit: 'percent',
    windowMinutes,
    resetsAt: new Date(fetchedAt + resetsInMs).toISOString(),
    observedAt: new Date(fetchedAt).toISOString(),
    fetchedAt: new Date(fetchedAt).toISOString(),
    staleAfterSeconds: 900,
  };
}

describe('computeQuotaPace：只对可信百分比窗口外推', () => {
  it('按窗口开始以来的平均速度外推到重置，并给出放慢/加快一半的范围', () => {
    const pace = computeQuotaPace(window({ used: 30 }), NOW, STABLE);
    expect(pace.kind).toBe('quota-pace');
    expect(pace.status).toBe('ok');
    expect(pace.reason).toBeNull();
    expect(pace.elapsedFraction).toBeCloseTo(0.5, 12);
    expect(pace.windowStartAt).toBe(NOW - 150 * MINUTE);
    expect(pace.projectedDemandPercent).toBeCloseTo(60, 10);
    expect(pace.projectedUsedAtReset).toBeCloseTo(60, 10);
    expect(pace.projectedRange!.low).toBeCloseTo(45, 10);
    expect(pace.projectedRange!.high).toBeCloseTo(75, 10);
    expect(pace.willExhaustBeforeReset).toBe(false);
    expect(pace.exhaustsAt).toBeNull();
    expect(pace.exhaustsAtRange).toBeNull();
    expect(pace.currentLevel).toBe('ok');
    // reset 在观测后 150 分钟：推断精度为整分钟，远小于窗口的 5%。
    expect(pace.resetPrecisionSeconds).toBe(60);
  });

  it('照此速度重置前跌进 D4 告急区（剩余 <20%）为 tight；此时不给“加快一半会用完”的时刻', () => {
    const pace = computeQuotaPace(window({ used: 45 }), NOW, STABLE);
    expect(pace.projectedDemandPercent).toBeCloseTo(90, 10);
    expect(100 - pace.projectedDemandPercent!).toBeLessThan(PACE_TIGHT_REMAINING_PERCENT);
    expect(pace.status).toBe('tight');
    expect(pace.currentLevel).toBe('ok');
    // 加快一半时重置时约用 112.5%：只体现在 projectedRange，不给用完时刻，免得与 tight 矛盾。
    expect(pace.projectedRange!.high).toBe(100);
    expect(pace.exhaustsAt).toBeNull();
    expect(pace.exhaustsAtRange).toBeNull();
  });

  it('当前已在告急区的窗口至少是 tight，与额度条颜色不矛盾', () => {
    const pace = computeQuotaPace(window({ used: 85, elapsedMinutes: 285 }), NOW, STABLE);
    expect(pace.currentLevel).toBe('critical');
    expect(pace.status).toBe('tight');
    expect(pace.projectedDemandPercent).toBeCloseTo(85 * 300 / 285, 10);
  });

  it('会在重置前用完为 critical，并给出用完时刻与区间', () => {
    const pace = computeQuotaPace(window({ used: 60 }), NOW, STABLE);
    expect(pace.status).toBe('critical');
    expect(pace.willExhaustBeforeReset).toBe(true);
    expect(pace.exhausted).toBe(false);
    expect(pace.projectedDemandPercent).toBeCloseTo(120, 10);
    expect(pace.projectedUsedAtReset).toBe(100);
    // 0.4%/分钟，剩 40% → 100 分钟后；重置在 150 分钟后。
    expect(pace.exhaustsAt).toBe(NOW + 100 * MINUTE);
    expect(pace.exhaustsAtRange!.earliest).toBe(NOW + 4_000_000);
    // 放慢一半要 200 分钟，晚于重置：最晚一端为“撑到重置”。
    expect(pace.exhaustsAtRange!.latest).toBeNull();
    expect(pace.projectedRange!.low).toBeCloseTo(90, 10);
    expect(pace.projectedRange!.high).toBe(100);
  });

  it('已经用完直接告急，即使窗口刚开始', () => {
    const pace = computeQuotaPace(window({ used: 100, elapsedMinutes: 10 }), NOW, STABLE);
    expect(pace).toMatchObject({
      status: 'critical', exhausted: true, willExhaustBeforeReset: true, exhaustsAt: NOW, projectedUsedAtReset: 100,
    });
  });

  it('刚重置时不外推：5 小时窗口至少过 30 分钟，每周窗口至少过一整天', () => {
    const early = computeQuotaPace(window({ used: 20, elapsedMinutes: 20 }), NOW, STABLE);
    expect(early).toMatchObject({ status: 'insufficient', reason: 'too-early', minElapsedMs: 30 * MINUTE });
    expect(early.projectedDemandPercent).toBeNull();
    expect(computeQuotaPace(window({ used: 20, elapsedMinutes: 30 }), NOW, STABLE).status).toBe('critical');

    const weekly = { windowMinutes: 10_080, windowId: 'codex:secondary', windowLabel: '每周' };
    const weekEarly = computeQuotaPace(window({ ...weekly, used: 10, elapsedMinutes: 20 * 60 }), NOW, STABLE);
    expect(weekEarly).toMatchObject({ status: 'insufficient', reason: 'too-early', minElapsedMs: 24 * HOUR });
    const weekReady = computeQuotaPace(window({ ...weekly, used: 10, elapsedMinutes: 25 * 60 }), NOW, STABLE);
    expect(weekReady.status).toBe('ok');
    // reset 在观测后整 143 小时：推断为整小时精度，仍在每周窗口 5%（8.4 小时）之内。
    expect(weekReady.resetPrecisionSeconds).toBe(3_600);
    expect(weekReady.projectedDemandPercent).toBeCloseTo(10 * 10_080 / (25 * 60), 10);
  });

  it('从零时长绝不外推：观测略早于推算的窗口起点时按刚开始处理', () => {
    const skewed = computeQuotaPace(window({ used: 1, elapsedMinutes: -2 }), NOW, STABLE);
    expect(skewed).toMatchObject({ status: 'insufficient', reason: 'too-early', elapsedFraction: 0 });
  });

  it('观测时刻明显早于窗口起点或不早于重置时，时间线不一致', () => {
    expect(computeQuotaPace(window({ used: 10, elapsedMinutes: -30 }), NOW, STABLE)).toMatchObject({
      status: 'unsupported', reason: 'timeline-inconsistent',
    });
    // 观测在未来且晚于重置：来源的 reset 与观测互相矛盾。
    const future = window({ used: 10, observedAgoMinutes: -30 });
    future.resetsAt = new Date(NOW + 10 * MINUTE).toISOString();
    expect(computeQuotaPace(future, NOW, STABLE)).toMatchObject({ status: 'unsupported', reason: 'timeline-inconsistent' });
  });

  it('来源时钟略快（观测晚于 now）时仍按观测时刻计算', () => {
    const pace = computeQuotaPace(window({ used: 30, observedAgoMinutes: -1 }), NOW, STABLE);
    expect(pace.status).toBe('ok');
    expect(pace.projectedDemandPercent).toBeCloseTo(60, 10);
  });

  it('新鲜度与额度面板同源：来源标 stale、超过新鲜期或 reset 已过都不预测', () => {
    expect(computeQuotaPace(window({ used: 30, status: 'stale' }), NOW, STABLE)).toMatchObject({
      status: 'stale', reason: 'observation-stale', usedPercent: 30,
    });
    expect(computeQuotaPace(window({ used: 30, observedAgoMinutes: 16 }), NOW, STABLE)).toMatchObject({
      status: 'stale', reason: 'observation-stale',
    });
    expect(computeQuotaPace(window({ used: 30, observedAgoMinutes: 14 }), NOW, STABLE).status).toBe('ok');
    const elapsed = window({ used: 30, elapsedMinutes: 150 });
    expect(computeQuotaPace(elapsed, NOW + 151 * MINUTE, STABLE)).toMatchObject({ status: 'stale', reason: 'reset-elapsed' });
  });

  it('非百分比、不带数值或数值非法的窗口不支持', () => {
    expect(computeQuotaPace(window({ used: 30, unit: 'credits', limit: undefined, remaining: undefined }), NOW, STABLE))
      .toMatchObject({ status: 'unsupported', reason: 'not-percent' });
    expect(computeQuotaPace(window({ used: 30, status: 'error' }), NOW, STABLE))
      .toMatchObject({ status: 'unsupported', reason: 'values-unavailable' });
    expect(computeQuotaPace(window({ used: 120, remaining: undefined }), NOW, STABLE))
      .toMatchObject({ status: 'unsupported', reason: 'values-unavailable' });
    expect(computeQuotaPace(window({ used: 30, observedAt: '2026-09-24 10:00:00' }), NOW, STABLE))
      .toMatchObject({ status: 'unsupported', reason: 'invalid-timeline' });
    expect(computeQuotaPace(window({ used: 30 }), Number.NaN, STABLE))
      .toMatchObject({ status: 'unsupported', reason: 'invalid-timeline' });
  });

  it('缺窗口时长或重置时间时不支持，不虚构窗口起点', () => {
    const noLength = window({ used: 30 });
    noLength.windowMinutes = undefined;
    expect(computeQuotaPace(noLength, NOW, STABLE)).toMatchObject({
      status: 'unsupported', reason: 'window-length-unknown', usedPercent: 30,
    });
    expect(computeQuotaPace(window({ used: 30, resetsAt: undefined }), NOW, STABLE)).toMatchObject({
      status: 'unsupported', reason: 'reset-unknown',
    });
  });

  it('展示值封顶 100，已过比例落在 (0, 1]', () => {
    const pace = computeQuotaPace(window({ used: 90, elapsedMinutes: 60 }), NOW, DECLARED_PRECISE);
    expect(pace.projectedDemandPercent).toBeCloseTo(450, 10);
    expect(pace.projectedUsedAtReset).toBe(100);
    expect(pace.projectedRange).toEqual({ low: 100, high: 100 });
    expect(pace.elapsedFraction).toBeGreaterThan(0);
    expect(pace.elapsedFraction).toBeLessThanOrEqual(1);
  });
});

describe('reset 精度与来源能力：默认不信任', () => {
  it('从时间戳推断最粗的可能精度：整天、整小时、整分钟或更细', () => {
    const base = Date.parse('2026-09-23T01:02:03.456Z');
    expect(inferResetPrecisionSeconds(base + 4 * DAY, [base])).toBe(86_400);
    expect(inferResetPrecisionSeconds(base + 4 * DAY + 3 * HOUR, [base])).toBe(3_600);
    expect(inferResetPrecisionSeconds(base + 2 * HOUR + 30 * MINUTE, [base])).toBe(60);
    expect(inferResetPrecisionSeconds(base + 2 * HOUR + 30 * MINUTE + 1_500, [base])).toBe(0);
    // 观测与抓取时刻取最粗的一个；不在 reset 之前的基准不参与。
    expect(inferResetPrecisionSeconds(base + 4 * DAY, [base - 1_234, base])).toBe(86_400);
    expect(inferResetPrecisionSeconds(base, [base, base + DAY])).toBe(0);
  });

  it('Claude PTY 每周窗口“Resets in 4 days”：按整天精度拒绝，不会把 critical 算成 ok 或 tight', () => {
    // 真实周期为周一 08:00 至下周一 08:00；周三 09:00 观测，真实已过 49 小时，还剩 4 天 23 小时。
    const observed = Date.parse('2026-09-23T09:00:00.417+08:00');
    for (const used of [30, 40]) {
      const pace = computeQuotaPace(claudePtyWindow(used, 10_080, 4 * DAY, observed), observed, { providerCapability: 'plan-dependent' });
      expect(pace).toMatchObject({ status: 'unsupported', reason: 'reset-imprecise', resetPrecisionSeconds: 86_400 });
      expect(describeQuotaPace(pace, observed)).toBeNull();
    }
    // 同一来源写成“4 天 3 小时”时精度为整小时，在每周窗口的 5% 之内。
    const finer = computeQuotaPace(
      claudePtyWindow(30, 10_080, 4 * DAY + 3 * HOUR, observed), observed, { providerCapability: 'plan-dependent' },
    );
    expect(finer).toMatchObject({ status: 'ok', resetPrecisionSeconds: 3_600 });
  });

  it('5 小时窗口：“2h 30m”精度为整分钟照常计算；只写“3h”按整小时精度拒绝', () => {
    const observed = Date.parse('2026-09-23T09:00:00.417+08:00');
    const minutes = computeQuotaPace(claudePtyWindow(30, 300, 2 * HOUR + 30 * MINUTE, observed), observed, STABLE);
    expect(minutes).toMatchObject({ status: 'ok', resetPrecisionSeconds: 60 });
    const hours = computeQuotaPace(claudePtyWindow(30, 300, 3 * HOUR, observed), observed, STABLE);
    expect(hours).toMatchObject({ status: 'unsupported', reason: 'reset-imprecise', resetPrecisionSeconds: 3_600 });
  });

  it('观测时刻与抓取时刻不同时，按抓取时刻换算的整数倍同样识别', () => {
    const fetched = Date.parse('2026-09-24T09:59:58.500Z');
    const snapshot = claudePtyWindow(30, 300, 3 * HOUR, fetched);
    snapshot.observedAt = new Date(fetched - 1_500).toISOString();
    expect(computeQuotaPace(snapshot, fetched, STABLE)).toMatchObject({ status: 'unsupported', reason: 'reset-imprecise' });
  });

  it('来源声明的精度优先于推断，两个方向都生效；非法声明视为不可信', () => {
    const weekly = window({ used: 20, windowMinutes: 10_080, elapsedMinutes: 3 * 24 * 60 });
    // reset 在观测后整 4 天：默认推断为整天精度而拒绝。
    expect(computeQuotaPace(weekly, NOW, STABLE)).toMatchObject({ status: 'unsupported', reason: 'reset-imprecise' });
    expect(computeQuotaPace(weekly, NOW, { ...STABLE, resetPrecisionSeconds: 60 })).toMatchObject({
      status: 'ok', resetPrecisionSeconds: 60,
    });
    expect(computeQuotaPace(window({ used: 30 }), NOW, { ...STABLE, resetPrecisionSeconds: 86_400 })).toMatchObject({
      status: 'unsupported', reason: 'reset-imprecise',
    });
    expect(computeQuotaPace(window({ used: 30 }), NOW, { ...STABLE, resetPrecisionSeconds: -1 }).reason).toBe('reset-imprecise');
    expect(computeQuotaPace(window({ used: 30 }), NOW, { ...STABLE, resetPrecisionSeconds: Number.NaN }).reason)
      .toBe('reset-imprecise');
  });

  it('来源能力必须给出：experimental 或未知能力都不预测', () => {
    expect(computeQuotaPace(window({ used: 30 }), NOW, { providerCapability: 'plan-dependent' }).status).toBe('ok');
    expect(computeQuotaPace(window({ used: 30 }), NOW, { providerCapability: 'experimental' })).toMatchObject({
      status: 'unsupported', reason: 'provider-experimental',
    });
    // @ts-expect-error providerCapability 必填
    expect(computeQuotaPace(window({ used: 30 }), NOW, {}).reason).toBe('provider-experimental');
    // @ts-expect-error options 必填
    expect(computeQuotaPace(window({ used: 30 }), NOW).reason).toBe('provider-experimental');
    // 非百分比窗口仍先报告 not-percent。
    expect(computeQuotaPace(window({ used: 30, unit: 'credits', limit: undefined, remaining: undefined }), NOW, {
      providerCapability: 'experimental',
    }).reason).toBe('not-percent');
  });

  it('共享额度 fixture：按各自 envelope 的能力与默认精度推断，每类窗口得到确定的判定', () => {
    const providers = completeFixture.providers as unknown as QuotaProviderEnvelope[];
    const now = Date.parse('2026-07-15T08:30:00+08:00');
    const judge = (override?: QuotaProviderEnvelope['capability']) => Object.fromEntries(
      providers.flatMap((provider) => provider.windows.map((item) => {
        const pace = computeQuotaPace(item, now, { providerCapability: override ?? provider.capability });
        return [item.windowId, `${pace.status}:${pace.reason ?? ''}`];
      })),
    );
    expect(judge()).toEqual({
      'codex:primary': 'ok:',
      'codex:secondary': 'critical:',
      'codex:credits-balance': 'unsupported:not-percent',
      'codex:credits-unlimited': 'unsupported:not-percent',
      'claude:five-hour': 'stale:observation-stale',
      'antigravity-gemini-models-gemini-session': 'unsupported:provider-experimental',
      'antigravity-gemini-models-gemini-weekly': 'unsupported:provider-experimental',
      'antigravity-claude-and-gpt-models-claude-session': 'unsupported:provider-experimental',
      'antigravity-claude-and-gpt-models-claude-weekly': 'unsupported:provider-experimental',
      'manual:2026-07': 'unsupported:not-percent',
    });
    // 同一批窗口若来源可信：fixture 的 reset 都精确到分钟，默认推断不会误拒。
    expect(judge('stable')).toMatchObject({
      'antigravity-gemini-models-gemini-session': 'ok:',
      'antigravity-gemini-models-gemini-weekly': 'ok:',
      'antigravity-claude-and-gpt-models-claude-session': 'unsupported:reset-unknown',
    });

    const weekly = computeQuotaPace(providers[0].windows[1], now, { providerCapability: providers[0].capability });
    // 7 天窗口已过 96.5 小时、已用 64%：照此速度约 54.3 小时后（北京时间周五 14:47）用完，早于周六 08:00 重置。
    expect(weekly.elapsedFraction).toBeCloseTo(96.5 / 168, 10);
    expect(weekly.projectedDemandPercent).toBeCloseTo(64 * 168 / 96.5, 10);
    expect(weekly.exhaustsAt).toBe(now + Math.round((36 / 64) * 96.5 * HOUR));
    expect(new Date(weekly.exhaustsAt!).toISOString()).toBe('2026-07-17T06:46:52.500Z');
    expect(weekly.resetPrecisionSeconds).toBe(60);
  });
});

describe('describeQuotaPace：标签、方法与区间', () => {
  it('ok：说明重置时约用多少，并给方法、区间与读屏整句', () => {
    const copy = describeQuotaPace(computeQuotaPace(window({ used: 30 }), NOW, STABLE), NOW)!;
    expect(copy).toEqual({
      tag: '预测',
      tone: 'neutral',
      text: '照此速度，重置时约用 60%',
      method: '按窗口开始以来的平均速度外推（已过 50% 时间，已用 30%）',
      interval: '区间：放慢一半到加快一半，重置时约用 45%–75%',
      ariaLabel: '预测：照此速度，重置时约用 60%。按窗口开始以来的平均速度外推（已过 50% 时间，已用 30%）。'
        + '区间：放慢一半到加快一半，重置时约用 45%–75%。',
    });
  });

  it('tight：说明重置时约剩多少，不复用额度条的等级词', () => {
    const copy = describeQuotaPace(computeQuotaPace(window({ used: 45 }), NOW, STABLE), NOW)!;
    expect(copy.tone).toBe('warning');
    expect(copy.text).toBe('照此速度，重置时约剩 10%');
  });

  it('critical：说明多久后用完，区间可能“撑到重置”', () => {
    const copy = describeQuotaPace(computeQuotaPace(window({ used: 60 }), NOW, STABLE), NOW)!;
    expect(copy.tone).toBe('danger');
    expect(copy.text).toBe('照此速度约 1.5 小时后用完，早于重置');
    expect(copy.interval).toBe('区间：加快一半约 1 小时后用完；放慢一半可撑到重置');

    const fast = describeQuotaPace(computeQuotaPace(window({ used: 90, elapsedMinutes: 60 }), NOW, DECLARED_PRECISE), NOW)!;
    expect(fast.interval).toBe('区间：约 5 分钟–15 分钟后用完');
  });

  it('区间端点已经过去时不写成“约 5 分钟后”', () => {
    // 12 分钟前观测、已用 90%、窗口已过 20%：照此速度与加快一半都已用完，放慢一半约 1 分钟后。
    const late = describeQuotaPace(
      computeQuotaPace(window({ used: 90, elapsedMinutes: 60, observedAgoMinutes: 12 }), NOW, DECLARED_PRECISE), NOW,
    )!;
    expect(late.text).toBe('照此速度可能已经用完，等待来源刷新');
    expect(late.interval).toBe('区间：加快一半时应已用完；放慢一半约 5 分钟后用完');

    // 14 分钟前观测：三种速度下都已用完，只保留主文案。
    const gone = describeQuotaPace(
      computeQuotaPace(window({ used: 90, elapsedMinutes: 60, observedAgoMinutes: 14 }), NOW, DECLARED_PRECISE), NOW,
    )!;
    expect(gone.text).toBe('照此速度可能已经用完，等待来源刷新');
    expect(gone.interval).toBeNull();
    expect(gone.ariaLabel).toBe('预测：照此速度可能已经用完，等待来源刷新。按窗口开始以来的平均速度外推（已过 20% 时间，已用 90%）。');

    // 加快一半已用完，放慢一半撑得到重置。
    const edge = describeQuotaPace(
      computeQuotaPace(window({ used: 95, elapsedMinutes: 280, observedAgoMinutes: 12 }), NOW, STABLE), NOW,
    )!;
    expect(edge.interval).toBe('区间：加快一半时应已用完；放慢一半可撑到重置');
  });

  it('窗口刚开始时给中性说明；当前已告急、不支持、历史数据与已用完不显示', () => {
    const early = describeQuotaPace(computeQuotaPace(window({ used: 5, elapsedMinutes: 10 }), NOW, STABLE), NOW)!;
    expect(early).toMatchObject({ tone: 'neutral', text: '窗口刚开始，暂不计算速度', interval: null });
    expect(early.method).toBe('窗口过去 30 分钟后才按平均速度预测');
    // 20 分钟用掉 85%：额度条已是红色，“刚开始”的中性说明只会显得矛盾。
    const burst = computeQuotaPace(window({ used: 85, elapsedMinutes: 20 }), NOW, STABLE);
    expect(burst).toMatchObject({ status: 'insufficient', currentLevel: 'critical' });
    expect(describeQuotaPace(burst, NOW)).toBeNull();
    const warm = computeQuotaPace(window({ used: 60, elapsedMinutes: 20 }), NOW, STABLE);
    expect(warm.currentLevel).toBe('warn');
    expect(describeQuotaPace(warm, NOW)!.text).toBe('窗口刚开始，暂不计算速度');
    expect(describeQuotaPace(computeQuotaPace(window({ used: 30, status: 'stale' }), NOW, STABLE), NOW)).toBeNull();
    expect(describeQuotaPace(computeQuotaPace(window({ used: 30, resetsAt: undefined }), NOW, STABLE), NOW)).toBeNull();
    expect(describeQuotaPace(computeQuotaPace(window({ used: 100 }), NOW, STABLE), NOW)).toBeNull();
  });

  it('速度文案只叫「预测」，不用「预估」「估算」，也不复用额度条的等级词（T10.154 / D4）', () => {
    const copies = [
      computeQuotaPace(window({ used: 30 }), NOW, STABLE),
      computeQuotaPace(window({ used: 45 }), NOW, STABLE),
      computeQuotaPace(window({ used: 60 }), NOW, STABLE),
      computeQuotaPace(window({ used: 5, elapsedMinutes: 10 }), NOW, STABLE),
    ].map((pace) => describeQuotaPace(pace, NOW)!);
    expect(copies.map((copy) => copy.tone)).toEqual(['neutral', 'warning', 'danger', 'neutral']);
    for (const copy of copies) {
      expect(copy.tag).toBe('预测');
      expect(copy.ariaLabel.startsWith(`预测：${copy.text}。${copy.method}。`)).toBe(true);
      const text = [copy.text, copy.method, copy.interval ?? '', copy.ariaLabel].join(' ');
      expect(text).not.toMatch(/预估|估算|告急|偏紧/);
    }
  });

  it('时长按粗粒度显示，不给假精度', () => {
    expect(formatPaceDuration(2 * MINUTE)).toBe('5 分钟');
    expect(formatPaceDuration(47 * MINUTE)).toBe('45 分钟');
    expect(formatPaceDuration(100 * MINUTE)).toBe('1.5 小时');
    expect(formatPaceDuration(14.4 * HOUR)).toBe('14 小时');
    expect(formatPaceDuration(54.3 * HOUR)).toBe('2.5 天');
  });
});
