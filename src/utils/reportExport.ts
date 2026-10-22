import { formatCacheNetSavedUsd } from './cacheSavingsDisplay';
import type { ComparisonDeltaMetric, CustomDateRange, DataScope, ModelStat, RangeKey, StatsData, ToolStat, UsageComparison } from '../types';
import { summaryEffectiveTokens } from '../types';
import { formatEstimatedUsd, formatNum, formatTokens } from './format';
import { ESTIMATED_COST_NOTE } from './costCopy';
import { buildRhythm, deriveInsightTimeContext, detectSpikes } from './insightRules';
import { calculateCacheEfficiency, escapeHtml } from './frontendContracts';
import { resolveCacheBreakdown } from './cacheDisplay';
import { modelCostDistribution, splitModelCacheRead } from './modelDistribution';
import { rangeDisplayName } from './rangeDisplay';
import { buildShareSummary, type ShareLayoutKey } from './shareSummary';
import { DIGEST_STYLES, DIGEST_THEMES } from './reportTheme';
import { parseCacheSavings } from './contracts/statsQuery';

export interface VisualDigestOptions {
  stats: StatsData;
  /** Companion visual direction selected in the share modal. */
  layout?: ShareLayoutKey;
  range: RangeKey;
  /** range === 'custom' 时的日期闭区间，用于标题与文件名。 */
  customRange?: CustomDateRange | null;
  scope: DataScope;
  appVersion: string;
  generatedAt?: string;
  /** 与分享弹窗“隐藏金额”开关一致（T10.163）：为 true 时，简报中所有金额、金额占比与金额同期变化一律显示“已隐藏”或整行省略，Token 与记录数不受影响。 */
  hideCosts?: boolean;
}

/**
 * `StatsData.tools/models` 在运行时是 `Record<string, T>`（契约 v1/v2），而旧调用方
 * 与测试 fixture 直接传数组。只认数组会让真实 App 的两张表永远为空，因此两种形态
 * 都在此归一，并按有效 Token 降序保证排行语义。
 */
function normalizeStatList<T extends { name: string; input?: number; output?: number }>(value: unknown): T[] {
  const items = Array.isArray(value)
    ? (value as T[])
    : value && typeof value === 'object'
      ? Object.values(value as Record<string, T>)
      : [];
  return [...items].sort((a, b) => ((b.input || 0) + (b.output || 0)) - ((a.input || 0) + (a.output || 0)));
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * 云端基线未验证时的判定必须与看板逐位一致（复核修复 P1-2）：不能把「没有可信
 * 基线」当成「基线为 0」显示「新增」。本文件坚持零 React 依赖，不从
 * TrendPanel.tsx 导入，原样复刻同一条件；reportExport.test.ts 有一条对拍测试，
 * 用 TrendPanel 导出的同名函数核对两处结果不会静默分叉。本地 scope 的零基线是
 * 真零，不受此判定影响，继续显示「新增」。
 */
export function isCloudComparisonBaselineUnverifiedLocal(
  scope: DataScope,
  comparison?: UsageComparison | null,
): boolean {
  return scope === 'cloud'
    && !!comparison
    && comparison.previous.summary.totalRequests === 0
    && comparison.previous.summary.totalTokens === 0;
}

/**
 * 同期变化文案：只在有可信百分比或 new/flat 语义时给出结论，其余一律返回
 * null 由调用方省略整行，不伪造 0%（与 `MetricsGrid.describeMetricChange` 同一约定——
 * 挂件卡片的 `cardModel.describeWidgetChange` 也调用它；`WidgetView.describeDelta`
 * 已随 T10.192 删除。简报是离线自包含文件，不跨文件复用组件内的实现）。
 *
 * 纵深防御（复核修复 P3-3）：导出是离线文件，不能假定 delta 一定经过 React
 * 边界校验——非有限 percent 一律省略而不是输出「+Infinity%」「−NaN%」；
 * direction 不是已知的四个字面量之一时视为不可得，不能被最后一行的三元表达式
 * 悄悄归类成「下降」。
 */
function describePeriodDelta(delta: ComparisonDeltaMetric | null | undefined, baselineUnverified: boolean): string | null {
  if (!delta) return null;
  if (baselineUnverified) return '基线缺失';
  if (!Number.isFinite(delta.absolute)) return null;
  if (delta.direction === 'new') return '新增';
  if (delta.direction === 'flat') return '持平';
  if (delta.direction !== 'up' && delta.direction !== 'down') return null;
  if (!Number.isFinite(delta.percent)) return null;
  const sign = delta.direction === 'up' ? '+' : '−';
  return `${sign}${Math.abs(delta.percent as number).toFixed(1)}%`;
}

/**
 * 自定义区间的日期优先取调用方传入的 customRange；分享弹窗入口迁移后一度丢失
 * 这个字段（回归，复核修复 P1-3：旧的设置页入口会传 customRange，新入口起初
 * 没有），因此在 customRange 缺失、range 又确实是 custom 时，回退到统计结果
 * 自带的查询回显 stats.meta.query.start/end——契约保证 range='custom' 时这两个
 * 字段一定回显（types.ts StatsQueryContext）。两者都没有时才真正显示通用的
 * 「自定义区间」占位标签，不假造日期。标题与下载文件名共用这一份解析，不会
 * 出现标题写了日期、文件名却没写的分叉。
 */
export function resolveEffectiveCustomRange(options: VisualDigestOptions): CustomDateRange | null {
  if (options.customRange) return options.customRange;
  if (options.range !== 'custom') return null;
  const query = options.stats.meta?.query;
  if (query?.start && query?.end) return { start: query.start, end: query.end };
  return null;
}

/**
 * 导出是离线文件，不能依赖调用点一定经过 React 边界校验。
 * 核心统计缺失时宁可拒绝生成，也不能把未知值写成 0。
 */
function assertExportableSummary(stats: StatsData): void {
  const summary = stats.summary;
  const required = ['inputTokens', 'outputTokens', 'cachedTokens', 'totalCost', 'totalRequests', 'avgTokensPerReq'] as const;
  for (const key of required) {
    if (!isNonNegativeFinite(summary?.[key])) {
      throw new Error(`统计数据不完整：summary.${key} 不可用于导出`);
    }
  }
  if (!Number.isFinite(summary.inputTokens + summary.outputTokens + summary.cachedTokens)) {
    throw new Error('统计数据不完整：Token 合计超出可导出范围');
  }
}

export function generateVisualDigestHtml(options: VisualDigestOptions): string {
  const { stats, range, scope, appVersion, hideCosts = false } = options;
  assertExportableSummary(stats);
  const nowStr = options.generatedAt || new Date().toLocaleString('zh-CN');
  const effectiveCustomRange = resolveEffectiveCustomRange(options);
  const rangeName = rangeDisplayName(range, effectiveCustomRange);
  const scopeName = scope === 'cloud' ? '已同步账本' : '本机账本';
  const layout = options.layout && Object.prototype.hasOwnProperty.call(DIGEST_THEMES, options.layout) ? options.layout : 'scorecard';
  const theme = DIGEST_THEMES[layout];
  const share = buildShareSummary({ stats, range, scope, hideCosts });
  const period = effectiveCustomRange ? `${effectiveCustomRange.start} 至 ${effectiveCustomRange.end}` : share.periodLabel;
  const sourceTime = stats.meta?.generatedAt || '来源未提供';
  const sourceZone = stats.meta?.timezone || stats.comparison?.window.timezone || '来源未提供';

  const summary = stats.summary;
  const effective = summaryEffectiveTokens(summary);
  const total = effective + (summary.cachedTokens || 0);
  const cacheEfficiency = calculateCacheEfficiency(summary);
  const cacheBreakdown = resolveCacheBreakdown(summary);
  const cacheSavedUsd = cacheEfficiency.kind === 'split' ? cacheEfficiency.totalSavedUsd : null;
  const cacheSavings = parseCacheSavings(summary.cacheSavings, summary);
  const cacheNetText = cacheSavings
    ? (hideCosts ? '费用已隐藏' : `缓存净节省 ${formatCacheNetSavedUsd(cacheSavings.netSavedUsd)}${cacheSavings.netSavedUsd < 0 ? '（写入溢价高于读取节省）' : ''}`)
    : '缓存净节省不可得';
  const cacheBreakdownText = cacheSavings
    ? (hideCosts ? '费用已隐藏' : `缓存读取节省 ${formatEstimatedUsd(cacheSavings.readSavedUsd)} · 缓存写入溢价 ${formatEstimatedUsd(cacheSavings.writePremiumUsd)} · ${cacheNetText}（各项分别四舍五入，合计可能相差 $0.01）${cacheSavings.fallbackPricedReadTokens + cacheSavings.fallbackPricedWriteTokens > 0 ? `（含兜底单价 · 读取 ${formatTokens(cacheSavings.fallbackPricedReadTokens)} / 写入 ${formatTokens(cacheSavings.fallbackPricedWriteTokens)} Token）` : ''}`)
    : cacheSavedUsd !== null ? (hideCosts ? '费用已隐藏' : `缓存读取节省 ${formatEstimatedUsd(cacheSavedUsd)}；写入溢价与净节省不可得`) : '缓存净节省明细不可得';
  const cacheFlowNote = cacheBreakdown.kind === 'split'
    ? `命中读 ${formatTokens(cacheBreakdown.read)} · 写 ${formatTokens(cacheBreakdown.write)}`
    : `缓存合计 ${formatTokens(cacheBreakdown.total)} · 来源未提供读写拆分`;
  // 同期变化（审计 Q11）：直接复用 Stats v2 已给出的 comparison.delta，不再自算，
  // 与看板/挂件同一份事实；缺 comparison 或方向不可信时返回 null，调用处整行省略。
  const expectedKinds: Partial<Record<RangeKey, UsageComparison['window']['kind']>> = { today: 'dayOverDay', week: 'weekOverWeek', month: 'monthOverMonth', custom: 'periodOverPeriod' };
  const expectedKind = expectedKinds[range];
  const comparison = stats.comparison?.window.kind === expectedKind ? stats.comparison : null;
  const baselineUnverified = isCloudComparisonBaselineUnverifiedLocal(scope, comparison);
  const tokenDeltaText = describePeriodDelta(comparison?.delta.tokens, baselineUnverified);
  const requestDeltaText = describePeriodDelta(comparison?.delta.requests, baselineUnverified);
  const costKnown = comparison && isNonNegativeFinite(comparison.current.summary.totalCost) && isNonNegativeFinite(comparison.previous.summary.totalCost);
  const costDeltaText = hideCosts ? null : comparison && !costKnown ? '费用不可比' : describePeriodDelta(comparison?.delta.cost, baselineUnverified);

  const topTools = normalizeStatList<ToolStat>(stats.tools);
  const topModels = normalizeStatList<ModelStat>(stats.models);
  const modelCostRows = modelCostDistribution(topModels, summary.totalCost);
  // 有明细时复用看板纯规则；导出入口先区分缺趋势与真实全零，不能将汇总中的
  // 消耗或 heatmap 冒充趋势桶。无时段语义（year 月桶）时仍整节省略。
  const insightContext = deriveInsightTimeContext(stats, range, scope, options.generatedAt);
  const trends = Array.isArray(stats.trends) ? stats.trends : [];
  const missingTrends = insightContext && range !== 'year' && trends.length === 0
    && (effective > 0 || summary.cachedTokens > 0 || summary.totalRequests > 0);
  const rhythm = insightContext && !missingTrends ? buildRhythm(trends, insightContext) : null;
  const hourlyRhythm = rhythm?.mode === 'hour' || range === 'today'
    || (range === 'custom' && !insightContext?.windowStart);
  const rhythmLabel = hourlyRhythm ? '分时段峰值' : '星期节奏（日均）';
  const rhythmSummary = missingTrends
    ? `趋势明细未提供，无法生成${hourlyRhythm ? '分时段峰值' : '星期节奏'}`
    : rhythm?.summary;
  const spikeDetection = insightContext && !missingTrends ? detectSpikes(trends, insightContext) : null;
  const spikeSummary = spikeDetection?.spikes.slice(0, 5).map((spike) =>
    `${spike.label} ${formatTokens(spike.value)}（${spike.ratio}×）`,
  ).join('；');

  const toolRows = topTools.map((tool) => {
    const eff = isNonNegativeFinite(tool.input) && isNonNegativeFinite(tool.output) && Number.isFinite(tool.input + tool.output) ? tool.input + tool.output : null;
    const sharePercent = effective > 0 && eff !== null ? Math.min(100, Math.round((eff / effective) * 1000) / 10) : null;
    const barWidth = sharePercent === null ? 0 : Math.min(100, Math.max(0, sharePercent));
    // 工具费用列（审计 Q11）：直接读 tools[].cost，不重算。已知金额受“隐藏金额”
    // 约束显示“已隐藏”；本就未知（非有限/负值/缺失）的一律“不可得”且不受隐藏
    // 开关影响——“不可得”不是金额，没有可隐藏的数字，绝不落回 0（GLB-01）。
    const toolCostStr = isNonNegativeFinite(tool.cost)
      ? (hideCosts ? '已隐藏' : formatEstimatedUsd(tool.cost))
      : '不可得';
    return `
      <tr>
        <td class="name-cell"><span>${escapeHtml(tool.name)}</span><span class="rank-bar" aria-hidden="true"><i style="width:${barWidth}%"></i></span></td>
        <td class="num">${eff === null ? '不可得' : formatTokens(eff)}</td>
        <td class="num">${formatTokens(tool.input)}</td>
        <td class="num">${formatTokens(tool.output)}</td>
        <td class="num">${formatTokens(tool.cached)}</td>
        <td class="num">${sharePercent === null ? '—' : `${sharePercent}%`}</td>
        <td class="num cost-cell">${toolCostStr}</td>
      </tr>
    `;
  }).join('');

  // 隐藏金额时按金额排序仍会让读者从「Token 少、排名却靠前」反推出金额高低
  // （复核修复 P3-1：隐藏金额同时要盖住数字和排序语义，参照 T10.136 对 Android
  // 金额隐身的既有规则）；改按有效 Token 降序，与「金额已隐藏」的列内容一致。
  const modelRowsSource = hideCosts
    ? [...modelCostRows].sort((a, b) => (b.effectiveTokens ?? -1) - (a.effectiveTokens ?? -1))
    : modelCostRows;
  const modelRows = modelRowsSource.map((row) => {
    const model = row.model;
    const reuseStr = row.cacheReusePercent !== null ? `${row.cacheReusePercent}%` : '—';
    // 金额与金额占比同受“隐藏金额”约束（占比由金额算出，隐藏时一并隐藏）；但
    // 本就不可得的金额没有数字可藏，隐藏开关不改写“不可得”这一诚实状态。
    const costStr = row.cost !== null ? (hideCosts ? '已隐藏' : formatEstimatedUsd(row.cost)) : '不可得';
    const shareStr = row.costSharePercent !== null ? (hideCosts ? '已隐藏' : `${row.costSharePercent}%`) : '—';
    const barWidth = hideCosts || row.costSharePercent === null ? 0 : Math.min(100, Math.max(0, row.costSharePercent));
    const effectiveStr = row.effectiveTokens !== null ? formatTokens(row.effectiveTokens) : '不可得';
    const { cacheRead } = splitModelCacheRead(model);
    const cacheStr = cacheRead !== null
      ? `命中读 ${formatTokens(cacheRead)}`
      : typeof model.cached === 'number' && Number.isFinite(model.cached) && model.cached >= 0
        ? `合计 ${formatTokens(model.cached)} · 未拆分`
        : '不可得';
    return `
      <tr>
        <td class="name-cell"><span>${escapeHtml(model.name)}</span><span class="rank-bar model-rank-bar" aria-hidden="true"><i style="width:${barWidth}%"></i></span></td>
        <td class="num cost-cell">${costStr}</td>
        <td class="num">${shareStr}</td>
        <td class="num">${effectiveStr}</td>
        <td class="num">${cacheStr}</td>
        <td class="num">${reuseStr}</td>
      </tr>
    `;
  }).join('');

  // 每日预估费用表（审计 Q11）：直接复用 Stats v2 已给出的 dailyCosts，逐日诚实展示；
  // 云端旧契约或本机未提供时该字段整体缺失，此处不臆造，整节省略。
  const dailyCosts = stats.dailyCosts ?? null;
  // year/all 范围可能有上千个活跃日，逐行渲染会把「简报」变成几百 KB 的长表格
  // （复核评审用 1095 个活跃日复现）；超过上限时只展示最近一段并如实注明，不
  // 悄悄截断后假装完整。
  const MAX_DAILY_ROWS = 120;
  const dailyDaysAll = dailyCosts?.days ?? [];
  const dailyTruncated = dailyDaysAll.length > MAX_DAILY_ROWS;
  const dailyDaysShown = dailyTruncated ? dailyDaysAll.slice(-MAX_DAILY_ROWS) : dailyDaysAll;
  const dailyRows = dailyDaysShown.map((day) => {
    // 纵深防御（复核修复 P3-3）：契约要求 recorded-estimate 的 amountUsd 严格
    // 为正的有限数，但导出是离线文件，不能假定调用点一定先过 React/契约校验，
    // 畸形值（null、字符串、负数）一律「不可得」，不能被悄悄转成「≈$0.00」。
    const amountStr = day.status === 'recorded-estimate' && isNonNegativeFinite(day.amountUsd)
      ? (hideCosts ? '已隐藏' : formatEstimatedUsd(day.amountUsd))
      : '不可得';
    return `
      <tr>
        <td class="name-cell">${escapeHtml(day.date)}</td>
        <td class="num cost-cell">${amountStr}</td>
      </tr>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TokenLedger 消耗分析简报 - ${escapeHtml(rangeName)}</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
  <meta name="color-scheme" content="light">
  <style>:root { --paper: ${theme.paper}; --text: ${theme.ink}; --accent: ${theme.accent}; --cover: ${theme.cover}; --cover-ink: ${theme.coverInk}; }
${DIGEST_STYLES}</style>
</head>
<body data-layout="${layout}">
  <div class="report-container">
    <div class="file-note"><span>OFFLINE EDITION / ${theme.name}</span><span>单文件简报 · 可离线阅读</span></div>

    <header class="report-header">
      <div class="cover-art" aria-hidden="true"></div>
      <div>
        <div class="brand-kicker">TokenLedger</div>
        <span class="edition">${theme.issue}</span>
        <h1 class="brand-title">${escapeHtml(rangeName)} AI 协作简报</h1>
        <p class="brand-sub">当前范围的输入、输出、缓存与预估费用（${ESTIMATED_COST_NOTE}）</p>
      </div>
      <div class="report-meta">
        <span class="badge">${escapeHtml(scopeName)} · ${escapeHtml(period)}</span>
        ${hideCosts ? '<span class="hidden-costs-badge">费用已隐藏</span>' : ''}
        ${stats.meta?.stale ? '<div>数据状态：缓存快照（可能不是最新）</div>' : ''}
        <div>来源时间：${escapeHtml(sourceTime)}</div>
        <div>统计时区：${escapeHtml(sourceZone)}</div>
        <div>导出时间：${escapeHtml(nowStr)}</div>
        <div>客户端版本：v${escapeHtml(appVersion)}</div>
      </div>
    </header>

    <main>
      <div class="kpi-grid">
        <div class="kpi-card kpi-card-primary">
          <div class="kpi-label">有效 Token</div>
          <div class="kpi-value">${formatTokens(effective)}</div>
          <div class="kpi-sub exact-value">${formatNum(effective)} Token · 输入 + 输出，不重复计入缓存</div>
          <div class="kpi-sub">输入 ${formatTokens(summary.inputTokens)} / 输出 ${formatTokens(summary.outputTokens)}</div>
          ${tokenDeltaText ? `<div class="kpi-delta">较上期 ${escapeHtml(tokenDeltaText)}</div>` : ''}
        </div>

        <div class="kpi-card">
          <div class="kpi-label">总计 Tokens（含缓存）</div>
          <div class="kpi-value">${formatTokens(total)}</div>
          <div class="kpi-sub">${cacheFlowNote}</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-label">预估费用</div>
          <div class="kpi-value">${hideCosts ? '已隐藏' : formatEstimatedUsd(summary.totalCost)}</div>
          <div class="kpi-sub">${escapeHtml(cacheNetText)}</div>
          ${costDeltaText ? `<div class="kpi-delta">较上期 ${escapeHtml(costDeltaText)}</div>` : ''}
        </div>

        <div class="kpi-card">
          <div class="kpi-label">Prompt 缓存复用率</div>
          <div class="kpi-value" style="color: var(--accent);">${cacheEfficiency.kind === 'split' ? `${cacheEfficiency.cacheRatioPercent}%` : '—'}</div>
          <div class="kpi-sub">${cacheEfficiency.kind === 'split'
            ? '命中读 ÷（输入 + 命中读）'
            : '来源未提供读写拆分，无法给出复用率'}</div>
        </div>
      </div>

      <div class="cache-observation">
        <div>
          <div class="observation-title">缓存观察</div>
          <div class="observation-desc">
            ${cacheBreakdown.kind === 'split'
              ? `命中缓存读 ${formatTokens(cacheBreakdown.read)} Tokens · 写入 ${formatTokens(cacheBreakdown.write)} Tokens。${escapeHtml(cacheBreakdownText)}（${ESTIMATED_COST_NOTE}）。`
              : `缓存合计 ${formatTokens(cacheBreakdown.total)} Tokens；来源未提供读写拆分，不显示流向、复用率或缓存净节省。`}
          </div>
        </div>
        <div class="observation-facts">
          活跃模型数：${topModels.length} 个 · 记录数 ${formatNum(summary.totalRequests)} 条${requestDeltaText ? `（较上期 ${escapeHtml(requestDeltaText)}）` : ''} · 均耗 ${formatTokens(summary.avgTokensPerReq || 0)}
        </div>
      </div>

      <h2 class="section-title">工具消耗排行</h2>
      <div class="table-container" tabindex="0" role="region" aria-label="可横向滚动的数据表">
        <table>
          <thead>
            <tr>
              <th scope="col">工具名称</th>
              <th scope="col" class="num">有效 Token</th>
              <th scope="col" class="num">输入</th>
              <th scope="col" class="num">输出</th>
              <th scope="col" class="num">缓存</th>
              <th scope="col" class="num">Token 占比</th>
              <th scope="col" class="num">预估费用</th>
            </tr>
          </thead>
          <tbody>
            ${toolRows || '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">暂无工具消耗记录</td></tr>'}
          </tbody>
        </table>
      </div>

      <h2 class="section-title">模型费用分布</h2>
      <div class="table-container" tabindex="0" role="region" aria-label="可横向滚动的数据表">
        <table>
          <thead>
            <tr>
              <th scope="col">模型名称</th>
              <th scope="col" class="num">预估费用</th>
              <th scope="col" class="num">费用占比</th>
              <th scope="col" class="num">有效 Token</th>
              <th scope="col" class="num">缓存口径</th>
              <th scope="col" class="num">复用率</th>
            </tr>
          </thead>
          <tbody>
            ${modelRows || '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">暂无模型消耗记录</td></tr>'}
          </tbody>
        </table>
      </div>

      ${dailyCosts ? `
      <h2 class="section-title">每日预估费用</h2>
      <div class="table-container" tabindex="0" role="region" aria-label="可横向滚动的数据表">
        <table>
          <thead>
            <tr>
              <th scope="col">日期</th>
              <th scope="col" class="num">预估费用</th>
            </tr>
          </thead>
          <tbody>
            ${dailyRows || '<tr><td colspan="2" style="text-align: center; color: var(--text-muted);">暂无每日记录</td></tr>'}
          </tbody>
        </table>
        <p style="padding: 0 16px 4px; font-size: 12px; color: var(--text-muted);">
          覆盖 ${dailyCosts.coverage.start ? escapeHtml(dailyCosts.coverage.start) : '账本最早记录'} 至 ${escapeHtml(dailyCosts.coverage.end)}（${escapeHtml(dailyCosts.coverage.timezone)}）${dailyCosts.coverage.state === 'partial' ? '；部分日期数据不完整，已如实标注为“不可得”' : ''}。
        </p>
        <p style="padding: 0 16px 14px; font-size: 12px; color: var(--text-muted);">
          按已有记录汇总，未逐笔核价；只列出有 Token 消耗的日期，未列出的日期在账本中没有消耗记录。${dailyTruncated ? `仅展示最近 ${MAX_DAILY_ROWS} 天；完整明细共 ${dailyDaysAll.length} 天，导出更短的范围可查看全部。` : ''}
        </p>
      </div>` : ''}

      ${rhythmSummary || spikeDetection ? `
      <h2 class="section-title">时段节奏与突增</h2>
      <div class="table-container" tabindex="0" role="region" aria-label="可横向滚动的数据表">
        <table>
          <tbody>
            ${rhythmSummary ? `
            <tr>
              <td class="name-cell">${rhythmLabel}</td>
              <td>${escapeHtml(rhythmSummary)}</td>
            </tr>` : ''}
            ${spikeDetection ? `
            <tr>
              <td class="name-cell">${spikeDetection.thresholdRatio > 0 ? `突增侦测（阈值：中位数的 ${spikeDetection.thresholdRatio}×）` : '突增侦测'}</td>
              <td>${escapeHtml(
                spikeDetection.state === 'flagged'
                  ? `检出 ${spikeDetection.spikes.length} 个突增时段：${spikeSummary}${spikeDetection.spikes.length > 5 ? ' 等' : ''}。`
                  : spikeDetection.state === 'calm'
                    ? `已完成基线中的 ${spikeDetection.bucketCount} 个时段，均未出现超过阈值的单桶突增。`
                    : spikeDetection.state === 'sparse'
                      ? `本期消耗集中在少数时段（${spikeDetection.bucketCount} 个时段中多数为零），缺少稳定基线，不评估突增。`
                      : '本期暂无消耗，未评估突增。',
              )}</td>
            </tr>` : ''}
          </tbody>
        </table>
      </div>` : ''}
    </main>

    <footer class="report-footer">
      <strong>TokenLedger / ${theme.name}</strong>
      <p>有效 Token = 输入 + 输出；缓存读写另列。不可得表示来源未提供可靠数据，已知零值仍为 0。</p>
      <p>预估费用${ESTIMATED_COST_NOTE}。</p>
      <p>${hideCosts ? '费用已隐藏：费用、费用占比与费用变化均未写入文件。' : '本文件含预估费用，转发前请确认分享范围。'} 文件只含本次导出的统计摘要，不含账户、设备标识、会话内容或项目数据。</p>
    </footer>
  </div>
</body>
</html>`;
}

export function downloadVisualDigest(options: VisualDigestOptions): boolean {
  let url: string | null = null;
  try {
    const html = generateVisualDigestHtml(options);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    url = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    // 文件名与标题共用同一份 customRange 解析（复核修复 P1-3），不会出现标题
    // 写了具体日期、文件名却退化成通用 "custom-<导出日>" 的分叉。
    const effectiveCustomRange = resolveEffectiveCustomRange(options);
    const rangeSlug = options.range === 'custom' && effectiveCustomRange
      ? `custom-${effectiveCustomRange.start}_${effectiveCustomRange.end}`
      : options.range;
    a.download = `tokenledger-digest-${rangeSlug}-${dateStr}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return true;
  } catch {
    return false;
  } finally {
    if (url) {
      try {
        const downloadUrl = url;
        setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
      } catch {
        // Cleanup failure must not turn a successful browser download into an error.
      }
    }
  }
}
