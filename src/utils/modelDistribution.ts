import type { ModelStat } from '../types';

/**
 * 模型消耗金额分布的纯计算层（REQ-DRILL-04）。金额来自 `model.cost`；
 * 命中缓存读只接受新契约中同时出现且与 `cached` 一致的
 * `model.cacheRead + model.cacheWrite`；旧数据降级为“缓存合计”，不从一侧
 * 反推另一侧，也不伪装成命中缓存。
 * 金额单位与调用方一致（桌面 USD、Android 人民币），此处不做汇率换算。
 */

export function splitModelCacheRead(model: Pick<ModelStat, 'cached' | 'cacheRead' | 'cacheWrite'>): {
  cacheRead: number | null;
  cacheWrite: number | null;
} {
  const cached = model.cached;
  const cacheWrite = model.cacheWrite;
  const explicitRead = model.cacheRead;
  if (typeof cached !== 'number' || !Number.isFinite(cached) || cached < 0) {
    return { cacheRead: null, cacheWrite: null };
  }
  const readIsValid = typeof explicitRead === 'number' && Number.isFinite(explicitRead) && explicitRead >= 0;
  const writeIsValid = typeof cacheWrite === 'number' && Number.isFinite(cacheWrite) && cacheWrite >= 0;
  if (readIsValid && writeIsValid && (explicitRead as number) + (cacheWrite as number) === cached) {
    return { cacheRead: explicitRead as number, cacheWrite: cacheWrite as number };
  }
  return { cacheRead: null, cacheWrite: null };
}

export type ModelCacheSegmentKind = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cacheCombined';

export interface ModelCacheSegment {
  kind: ModelCacheSegmentKind;
  label: string;
  tokens: number;
}

export interface ModelCacheBreakdown {
  segments: ModelCacheSegment[];
  hasReadWriteSplit: boolean;
  reusePercent: number | null;
  totalTokens: number;
}

/** 单个模型的命中缓存消耗分布：未命中输入 / 输出 / 命中缓存读 / 缓存写（或缓存合计）。 */
export function modelCacheBreakdown(model: Pick<ModelStat, 'input' | 'output' | 'cached' | 'cacheRead' | 'cacheWrite' | 'cost'>): ModelCacheBreakdown {
  const input = model.input ?? 0;
  const output = model.output ?? 0;
  const cached = model.cached ?? 0;
  const { cacheRead, cacheWrite } = splitModelCacheRead(model);
  const hasSplit = cacheRead !== null && cacheWrite !== null;

  const segments: ModelCacheSegment[] = [
    { kind: 'input', label: '未命中输入', tokens: input },
    { kind: 'output', label: '输出', tokens: output },
  ];
  if (hasSplit) {
    segments.push({ kind: 'cacheRead', label: '命中缓存读', tokens: cacheRead as number });
    segments.push({ kind: 'cacheWrite', label: '缓存写', tokens: cacheWrite as number });
  } else {
    segments.push({ kind: 'cacheCombined', label: '缓存合计', tokens: cached });
  }

  const reusePercent = hasSplit && input + (cacheRead as number) > 0
    ? Math.round(((cacheRead as number) / (input + (cacheRead as number))) * 1000) / 10
    : null;

  return {
    segments,
    hasReadWriteSplit: hasSplit,
    reusePercent,
    totalTokens: input + output + cached,
  };
}

export interface ModelCostRow {
  model: ModelStat;
  cost: number | null;
  costSharePercent: number | null;
  effectiveTokens: number | null;
  cacheReusePercent: number | null;
  requests: number;
}

/**
 * 全部模型按已知预估成本降序；缺失成本保留为 null 并排在已知行之后，绝不把
 * unknown 伪装成免费。金额占比优先使用同一范围 summary.totalCost 作分母，使
 * 未分配/未知模型成本不会把已知行重新归一到 100%。
 */
export function modelCostDistribution(models: ModelStat[], summaryTotalCost?: number): ModelCostRow[] {
  const rows = models
    .map((model) => {
      const inputKnown = typeof model.input === 'number' && Number.isFinite(model.input) && model.input >= 0;
      const outputKnown = typeof model.output === 'number' && Number.isFinite(model.output) && model.output >= 0;
      const effectiveTokens = inputKnown && outputKnown
        ? (model.input as number) + (model.output as number)
        : null;
      const cost = typeof model.cost === 'number' && Number.isFinite(model.cost) && model.cost >= 0
        ? model.cost
        : null;
      const { cacheRead } = splitModelCacheRead(model);
      const cacheReusePercent = cacheRead !== null && inputKnown && (model.input as number) + cacheRead > 0
        ? Math.round((cacheRead / ((model.input as number) + cacheRead)) * 1000) / 10
        : null;
      return {
        model,
        cost,
        costSharePercent: null,
        effectiveTokens,
        cacheReusePercent,
        requests: model.requests ?? 0,
      };
    })
    .filter((row) => {
      if (models.length <= 1) return true;
      return row.cost !== null
        || (row.effectiveTokens ?? 0) > 0
        || (row.model.cached ?? 0) > 0
        || row.model.total > 0;
    });

  const knownCostTotal = rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const totalCost = typeof summaryTotalCost === 'number'
    && Number.isFinite(summaryTotalCost)
    && summaryTotalCost >= knownCostTotal
    ? summaryTotalCost
    : knownCostTotal;
  const withShare = rows.map((row) => ({
    ...row,
    costSharePercent: row.cost !== null && totalCost > 0
      ? Math.round((row.cost / totalCost) * 1000) / 10
      : row.cost === 0 && totalCost === 0 ? 0 : null,
  }));
  withShare.sort((a, b) => {
    if (a.cost === null && b.cost !== null) return 1;
    if (a.cost !== null && b.cost === null) return -1;
    if (a.cost !== null && b.cost !== null && a.cost !== b.cost) return b.cost - a.cost;
    if ((a.effectiveTokens ?? 0) !== (b.effectiveTokens ?? 0)) {
      return (b.effectiveTokens ?? 0) - (a.effectiveTokens ?? 0);
    }
    return a.model.name < b.model.name ? -1 : 1;
  });
  return withShare;
}
