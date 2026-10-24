import { memo, useEffect, useId, useMemo, useState } from 'react';
import { ChevronDown, Compass } from 'lucide-react';
import { EChart } from './EChart';
import type { ModelStat } from '../types';
import { toolColorMap } from '../types';
import { formatAxisTokens, formatEstimatedUsd, formatNum, formatTokens, formatUsd } from '../utils/format';
import { computeUnitCostUsd, formatUnitCost, unitCostLabel } from '../utils/unitCost';
import { useTheme } from '../utils/useTheme';
import { escapeHtml } from '../utils/frontendContracts';
import { CHART_FONT_FAMILY, getChartAnimation, getChartGrid, getChartThemeTokens, getChartTooltip } from '../utils/chartTheme';
import '../styles/overviewDrill.css';

interface CostEfficiencyQuadrantProps {
  models: ModelStat[];
  onModelClick?: (model: ModelStat) => void;
  /** Screen-wide tool -> colour assignment computed by DashboardTab (T10.178 review P1-1); falls back to a local same-view assignment when absent. */
  toolColors?: Map<string, string>;
}

type DistributionZone = '高用量 · 高费用' | '低用量 · 高费用' | '高用量 · 低费用' | '低用量 · 低费用';

interface DistributionItem {
  model: ModelStat;
  effective: number;
  cost: number;
  requests: number;
  zone: DistributionZone;
}

export interface QuadrantExclusions {
  /** 缺少输入/输出拆分，无法算有效 Token。 */
  noBreakdown: number;
  /** 预估费用不可得（缺失、非有限或为负）。 */
  unknownCost: number;
  /** 有效 Token 与预估费用都是 0，没有可画的点。 */
  inactive: number;
}

/**
 * 把本期全部模型分成进图的与未纳入的，并按原因计数。调用方必须传入全部模型：
 * 截成 Token 前 8 会让低用量、高费用的模型无声消失（审计 P0-2）。
 */
export function partitionQuadrantModels(models: ModelStat[]): { plottable: ModelStat[]; excluded: QuadrantExclusions } {
  const excluded: QuadrantExclusions = { noBreakdown: 0, unknownCost: 0, inactive: 0 };
  const plottable: ModelStat[] = [];
  models.forEach((model) => {
    const hasIO = typeof model.input === 'number'
      && Number.isFinite(model.input)
      && model.input >= 0
      && typeof model.output === 'number'
      && Number.isFinite(model.output)
      && model.output >= 0;
    if (!hasIO) {
      excluded.noBreakdown += 1;
      return;
    }
    const hasCost = typeof model.cost === 'number' && Number.isFinite(model.cost) && model.cost >= 0;
    if (!hasCost) {
      excluded.unknownCost += 1;
      return;
    }
    if ((model.input as number) + (model.output as number) > 0 || (model.cost as number) > 0) {
      plottable.push(model);
    } else {
      excluded.inactive += 1;
    }
  });
  return { plottable, excluded };
}

function exclusionReasons(excluded: QuadrantExclusions): string[] {
  return [
    excluded.noBreakdown > 0 ? `${excluded.noBreakdown} 个缺少输入/输出拆分` : null,
    excluded.unknownCost > 0 ? `${excluded.unknownCost} 个预估费用不可得` : null,
    excluded.inactive > 0 ? `${excluded.inactive} 个本期没有有效 Token 与费用` : null,
  ].filter((reason): reason is string => reason !== null);
}

/** 脚注：写明本期模型总数、进图数，以及每类未纳入的原因与数量。 */
export function quadrantCoverageNote(total: number, plotted: number, excluded: QuadrantExclusions): string {
  const reasons = exclusionReasons(excluded);
  if (reasons.length === 0) return `本期 ${total} 个模型全部进图。`;
  return `本期 ${total} 个模型中 ${plotted} 个进图；未纳入：${reasons.join('，')}。`;
}

/** 空态的前提说明：比较至少要两个点。 */
export const QUADRANT_EMPTY_REQUIREMENT = '至少需要 2 个有预估费用和输入/输出拆分的模型，才能比较用量与预估费用。';

/** 少于 2 个模型可进图时的空态细节：不整卡消失，如实写出数量与未纳入原因（评审 P3-6）。 */
export function quadrantEmptyNote(total: number, plottable: number, excluded: QuadrantExclusions): string {
  const reasons = exclusionReasons(excluded);
  const count = plottable === 0
    ? `本期 ${total} 个模型都无法进图`
    : `本期 ${total} 个模型中只有 ${plottable} 个可进图`;
  return reasons.length === 0 ? `${count}。` : `${count}；未纳入：${reasons.join('，')}。`;
}

/**
 * 模型用量与费用分布。X=有效 Token（输入+输出），Y=预估费用。
 * 这只能回答规模与费用，不能推断任务质量或“效益”；缺费用或 I/O 拆分的模型
 * 明示排除。圆点使用已注册的 LineChart 透明连线实现，避免模块化运行时缺失
 * ScatterChart/MarkLineComponent 后得到空白画布。
 */
function CostEfficiencyQuadrantComponent({ models, onModelClick, toolColors }: CostEfficiencyQuadrantProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isCompact, setIsCompact] = useState(() => (
    typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 600px)').matches
  ));
  const { effective: effectiveTheme } = useTheme();
  const contentId = useId();
  const canDrill = Boolean(onModelClick);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia('(max-width: 600px)');
    const update = () => setIsCompact(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);

  const { plottable, excluded } = useMemo(() => partitionQuadrantModels(models), [models]);

  const distribution = useMemo(() => {
    if (plottable.length < 2) return null;
    const averageTokens = plottable.reduce(
      (sum, model) => sum + (model.input as number) + (model.output as number),
      0,
    ) / plottable.length;
    const averageCost = plottable.reduce((sum, model) => sum + (model.cost as number), 0) / plottable.length;
    const items: DistributionItem[] = plottable.map((model) => {
      const effective = (model.input as number) + (model.output as number);
      const cost = model.cost as number;
      const highTokens = effective >= averageTokens;
      const highCost = cost >= averageCost;
      const zone: DistributionZone = highTokens
        ? highCost ? '高用量 · 高费用' : '高用量 · 低费用'
        : highCost ? '低用量 · 高费用' : '低用量 · 低费用';
      return {
        model,
        effective,
        cost,
        requests: Number.isFinite(model.requests) ? model.requests : 0,
        zone,
      };
    });
    items.sort((left, right) => right.cost - left.cost || right.effective - left.effective);
    return { averageTokens, averageCost, items };
  }, [plottable]);

  const option = useMemo(() => {
    if (!isExpanded || !distribution) return null;
    const theme = getChartThemeTokens(effectiveTheme);
    const maxTokens = Math.max(...distribution.items.map((item) => item.effective), distribution.averageTokens, 1);
    const maxCost = Math.max(...distribution.items.map((item) => item.cost), distribution.averageCost, 0.01);
    // Falls back to a locally rank-ordered assignment (distribution.items is
    // already sorted cost desc, effective desc) when no screen-wide map was
    // passed in (T10.178 review P1-1).
    const colors = toolColors || toolColorMap(distribution.items.map((item) => item.model.tool || item.model.name), effectiveTheme);
    // Light theme: fully opaque instead of 0.88, which drops several
    // chart-slot colours under 3:1 on the white panel (review P2-2, root R-9).
    const pointOpacity = effectiveTheme === 'light' ? 1 : 0.88;
    const pointData = distribution.items.map((item) => ({
      name: item.model.name,
      value: [item.effective, item.cost, item.requests, item.model] as [number, number, number, ModelStat],
      symbolSize: Math.max(12, Math.min(38, Math.round(Math.sqrt(Math.max(item.requests, 1)) * 4) + 10)),
      itemStyle: {
        color: colors.get((item.model.tool || item.model.name).toLowerCase()),
        shadowBlur: 10,
        shadowColor: 'rgba(0, 0, 0, 0.25)',
        opacity: pointOpacity,
      },
    }));

    return {
      backgroundColor: 'transparent',
      ...getChartAnimation(theme.reduceMotion),
      textStyle: { fontFamily: CHART_FONT_FAMILY },
      grid: getChartGrid({ left: 14, right: 24, top: 28, bottom: 30 }),
      tooltip: getChartTooltip(theme, {
        trigger: 'item',
        formatter: (params: { data: typeof pointData[number] }) => {
          const item = params.data;
          const [tokens, cost, requests] = item.value;
          const averagePerRequest = requests > 0 ? Math.round(tokens / requests) : 0;
          // 单位费用统一为每百万有效 Token（T10.154 D35，原为每千）；计算与显示保护共用 utils/unitCost。
          const unitCost = tokens > 0 ? formatUnitCost(computeUnitCostUsd(cost, tokens)) : '—';
          return `
            <div style="font-size: 12px; line-height: 1.6;">
              <div style="font-weight: 700; margin-bottom: 4px; font-size: 13px;">${escapeHtml(item.name)}</div>
              <div>预估费用: <b style="color: ${theme.success};">${formatEstimatedUsd(cost)}</b></div>
              <div>有效 Token: <b>${formatTokens(tokens)}</b></div>
              <div style="color: ${theme.textSecondary};">记录数: ${formatNum(requests)} 条${requests > 0 ? ` · 每条均耗 ≈${formatTokens(averagePerRequest)}` : ''}</div>
              <div style="color: ${theme.textTertiary}; font-size: 11px; margin-top: 2px;">${unitCostLabel()}: ${escapeHtml(unitCost)}</div>
              ${canDrill ? `<div style="margin-top: 4px; border-top: 1px solid ${theme.borderStrong}; padding-top: 4px; font-size: 10px; color: ${theme.primary};">点击圆点打开专属看板</div>` : ''}
            </div>
          `;
        },
      }),
      xAxis: {
        name: '有效 Token 消耗',
        nameLocation: 'middle' as const,
        nameGap: 24,
        nameTextStyle: { color: theme.textTertiary, fontSize: 11 },
        type: 'value',
        max: Math.ceil(maxTokens * 1.08),
        splitLine: { lineStyle: { color: theme.borderFaint, type: 'dashed' as const } },
        axisLabel: { color: theme.textTertiary, formatter: (value: number) => formatAxisTokens(value) },
        axisLine: { lineStyle: { color: theme.borderFaint } },
      },
      yAxis: {
        name: '预估费用（USD）',
        nameLocation: 'end' as const,
        nameTextStyle: { color: theme.textTertiary, fontSize: 11 },
        type: 'value',
        max: Math.ceil(maxCost * 1.12 * 100) / 100,
        splitLine: { lineStyle: { color: theme.borderFaint, type: 'dashed' as const } },
        axisLabel: { color: theme.textTertiary, formatter: (value: number) => formatUsd(value) },
        axisLine: { lineStyle: { color: theme.borderFaint } },
      },
      series: [
        {
          name: '模型',
          type: 'line',
          data: pointData,
          showSymbol: true,
          symbol: 'circle',
          lineStyle: { opacity: 0 },
        },
        {
          name: '用量均值线',
          type: 'line',
          data: [[distribution.averageTokens, 0], [distribution.averageTokens, maxCost * 1.12]],
          symbol: 'none',
          silent: true,
          tooltip: { show: false },
          lineStyle: { color: theme.borderStrong, type: 'dotted' as const, width: 1.5 },
        },
        {
          name: '费用均值线',
          type: 'line',
          data: [[0, distribution.averageCost], [maxTokens * 1.08, distribution.averageCost]],
          symbol: 'none',
          silent: true,
          tooltip: { show: false },
          lineStyle: { color: theme.borderStrong, type: 'dotted' as const, width: 1.5 },
        },
      ],
    };
  }, [isExpanded, distribution, canDrill, effectiveTheme, toolColors]);

  const onEvents = useMemo(() => ({
    click: (params: { data?: { value?: [number, number, number, ModelStat] } }) => {
      const model = params.data?.value?.[3];
      if (model && onModelClick) onModelClick(model);
    },
  }), [onModelClick]);

  if (!distribution) {
    if (models.length === 0) return null;
    // Fewer than two plottable models: nothing to compare, but say why instead
    // of vanishing together with the per-reason counts (review P3-6).
    return (
      <section className="panel cost-efficiency-quadrant-panel" aria-label="模型用量与费用分布">
        <div className="panel-header">
          <span className="panel-title">
            <Compass className="h-4 w-4 text-primary" aria-hidden="true" />
            <span>模型用量与费用分布</span>
          </span>
        </div>
        <div className="quadrant-empty">
          <p className="quadrant-empty-requirement">{QUADRANT_EMPTY_REQUIREMENT}</p>
          <p className="quadrant-empty-detail">{quadrantEmptyNote(models.length, plottable.length, excluded)}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel cost-efficiency-quadrant-panel" aria-label="模型用量与费用分布">
      <button
        className="panel-header quadrant-disclosure"
        type="button"
        onClick={() => setIsExpanded((current) => !current)}
        aria-expanded={isExpanded}
        aria-controls={contentId}
      >
        <span className="panel-title">
          <Compass className="h-4 w-4 text-primary" />
          <span>模型用量与费用分布</span>
        </span>
        <span className="quadrant-disclosure-copy">
          {/* U-102：收起时只留箭头，展开后才给读图提示。 */}
          {isExpanded ? (
            <span className="text-xs text-muted">
              {isCompact
                ? `文字摘要 = 本期均值分区${canDrill ? ' · 点击模型下钻' : ''}`
                : `圆点大小 = 记录数 · 虚线 = 本期均值${canDrill ? ' · 点击圆点下钻' : ''}`}
            </span>
          ) : <span className="sr-only">展开比较模型用量与预估费用</span>}
          <ChevronDown
            className="h-4 w-4 text-tertiary"
            style={{ transform: isExpanded ? 'rotate(180deg)' : 'none' }}
          />
        </span>
      </button>

      {isExpanded && (
        <div className="quadrant-content-area" id={contentId}>
          {option && !isCompact && (
            <div className="quadrant-chart quadrant-desktop-only">
              <EChart
                option={option}
                onEvents={onEvents}
                ariaLabel={`模型用量与费用分布图：横轴有效 Token，纵轴预估费用，本期均值线形成四个规模与费用分区，共 ${distribution.items.length} 个模型。`}
              />
            </div>
          )}
          <p className="quadrant-mobile-note">窄屏隐藏坐标图；以下文字结论使用相同数据与本期均值。</p>
          <div className="quadrant-model-summary" aria-label="模型用量与费用分区摘要">
            {distribution.items.slice(0, 5).map((item) => {
              const content = (
                <>
                  <strong>{item.model.name}</strong>
                  <span>{item.zone}</span>
                  <span className="num">{formatTokens(item.effective)} · {formatEstimatedUsd(item.cost)}</span>
                </>
              );
              return onModelClick ? (
                <button
                  className="quadrant-model-summary-row is-action"
                  key={item.model.name}
                  type="button"
                  onClick={() => onModelClick(item.model)}
                  aria-label={`打开 ${item.model.name} 专属看板；${item.zone}；${formatTokens(item.effective)} Tokens；预估费用 ${formatEstimatedUsd(item.cost)}`}
                >
                  {content}
                </button>
              ) : (
                <div className="quadrant-model-summary-row" key={item.model.name}>{content}</div>
              );
            })}
          </div>
          <div className="quadrant-legend-footer">
            <span>{isCompact
              ? '文字分区只比较本期模型的用量与预估费用，不表示模型好坏。'
              : '虚线仅表示本期模型均值；点色用于区分工具，不表示分区好坏。'}</span>
            {distribution.items.length > 5 && <span>文字摘要仅列费用最高的前 5 个模型。</span>}
            <span>{quadrantCoverageNote(models.length, distribution.items.length, excluded)}</span>
          </div>
        </div>
      )}
    </section>
  );
}

export const CostEfficiencyQuadrantPanel = memo(CostEfficiencyQuadrantComponent);
export default CostEfficiencyQuadrantPanel;
