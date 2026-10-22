import type { EffectiveTheme } from './useTheme';

/**
 * ECharts 统一主题语言（T10.86）。
 * 所有看板图表从这里读取双主题语义色、tooltip 浮层、网格排版与字体栈；
 * 面板不允许再各自内联一份 getComputedStyle 读取或 tooltip 样式，避免主题漂移。
 * 色值全部来自 tokens.css 的语义令牌；fallback 只在无 DOM（测试/SSR）时生效。
 */

export function getCssToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** 图表统一字体栈：优先系统 UI 字体，数字对齐依赖等宽 fallback 由调用方决定。 */
export const CHART_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

export interface ChartThemeTokens {
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  border: string;
  borderStrong: string;
  borderFaint: string;
  bgPanel: string;
  bgOverlay: string;
  /** `--shadow-float`：浮层阴影，tooltip 与其他浮起层共用同一来源（T10.150）。 */
  shadowFloat: string;
  primary: string;
  primarySoftBg: string;
  success: string;
  warning: string;
  danger: string;
  /** `--chart-1…8`：系列色板，供不按工具着色的多系列图表使用（T10.150）。 */
  seriesPalette: readonly string[];
  /** 系统 reduced-motion 开关：图表动画一次性读取，reduced 时关闭非必要动画。 */
  reduceMotion: boolean;
}

const CHART_SERIES_VARS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--chart-7', '--chart-8'];
// Dark-only fallback (colour-vision palette B, T10.187 user decision U-4): only
// used when there is no DOM to read tokens.css from (tests/SSR); keep in sync
// with --chart-1..8's dark scope by hand, in the same commit.
const CHART_SERIES_FALLBACK = ['#6b9dff', '#907adc', '#2dd4bf', '#fbbf24', '#fb7185', '#3fe480', '#3dbdf7', '#fb923c'];

/**
 * 计算样式读取有布局成本（NFR-01 图表预算）。同一生效主题下令牌值不变，
 * 因此按当前 `data-theme` 缓存一份；`useTheme` 在触发重渲染前已同步写入该
 * 属性，所以这里同步比较属性即可命中/失效，无需 observer（observer 回调是
 * 微任务，会晚于本次渲染）。返回对象按约定只读，调用方不得修改。
 *
 * `reduceMotion` 单独实时读取（见下），但对外返回的对象引用在主题与
 * reduceMotion 都未变化时保持不变——面板把 `getChartThemeTokens()` 的结果
 * 放进 `useMemo` 依赖数组时，一次无关的重渲染（切换日期、点击热力格、父级
 * toast/五分钟刷新）不应让每张图表都当作"主题变了"重新 setOption，否则会
 * 抹掉图例的 selectedMode 选择并在 reduced-motion 下也重放入场动画
 * （T10.150 动效缺陷修复：BehaviorAnalysisView 五张图表曾经每次渲染必重建）。
 */
let cachedTokens: ChartThemeTokens | null = null;
let cachedTheme: string | null = null;
let cachedCombined: ChartThemeTokens | null = null;
let cachedCombinedReduceMotion: boolean | null = null;

export function getChartThemeTokens(themeIdentity?: EffectiveTheme): ChartThemeTokens {
  const reduceMotion = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return buildTokens(reduceMotion);
  }
  const theme = themeIdentity ?? document.documentElement.getAttribute('data-theme') ?? 'unknown';
  const themeChanged = !cachedTokens || cachedTheme !== theme;
  if (themeChanged) {
    cachedTokens = buildTokens(reduceMotion);
    cachedTheme = theme;
  }
  if (themeChanged || !cachedCombined || cachedCombinedReduceMotion !== reduceMotion) {
    cachedCombined = { ...(cachedTokens as ChartThemeTokens), reduceMotion };
    cachedCombinedReduceMotion = reduceMotion;
  }
  return cachedCombined;
}

function buildTokens(reduceMotion: boolean): ChartThemeTokens {
  return {
    textPrimary: getCssToken('--color-text-primary', '#f5f5f7'),
    textSecondary: getCssToken('--color-text-secondary', '#aeb4c0'),
    textTertiary: getCssToken('--color-text-tertiary', '#8993a3'),
    border: getCssToken('--color-border', 'rgba(255, 255, 255, 0.08)'),
    borderStrong: getCssToken('--color-border-strong', 'rgba(255, 255, 255, 0.12)'),
    borderFaint: getCssToken('--color-border-faint', 'rgba(255, 255, 255, 0.06)'),
    bgPanel: getCssToken('--color-bg-panel', '#242426'),
    // Tooltip/popover surface: sourced from --color-bg-popover per the T10.150
    // visual spec ("tooltip：--color-bg-popover 底"), kept under the existing
    // `bgOverlay` field name so callers/tests that read tokens.bgOverlay are
    // unaffected by the rename of its underlying CSS source.
    bgOverlay: getCssToken('--color-bg-popover', 'rgba(28, 28, 30, 0.96)'),
    shadowFloat: getCssToken('--shadow-float', '0 20px 50px -12px rgba(0, 0, 0, 0.66), 0 0 0 1px rgba(255, 255, 255, 0.05)'),
    primary: getCssToken('--color-primary', '#2f9aff'),
    primarySoftBg: getCssToken('--color-primary-soft-bg', 'rgba(47, 154, 255, 0.16)'),
    success: getCssToken('--color-success', '#30d158'),
    warning: getCssToken('--color-warning', '#ffd60a'),
    danger: getCssToken('--color-danger', '#ff6482'),
    seriesPalette: CHART_SERIES_VARS.map((name, index) => getCssToken(name, CHART_SERIES_FALLBACK[index])),
    reduceMotion,
  };
}

/**
 * 统一 tooltip 浮层：不透明/高对比表面 + 强边框 + 浮层阴影（GLB-05 浮层规则）。
 * customExtra 用于逐图覆盖（如 axis trigger、formatter）。
 */
export function getChartTooltip(
  tokens: ChartThemeTokens,
  customExtra?: Record<string, unknown>,
) {
  return {
    backgroundColor: tokens.bgOverlay,
    borderColor: tokens.borderStrong,
    borderWidth: 1,
    padding: [10, 14],
    textStyle: {
      color: tokens.textPrimary,
      fontFamily: CHART_FONT_FAMILY,
      fontSize: 12,
    },
    extraCssText: [
      `box-shadow: ${tokens.shadowFloat};`,
      'border-radius: 12px;',
      'line-height: 1.5;',
      'font-variant-numeric: tabular-nums;',
      'pointer-events: none;',
    ].join(' '),
    ...customExtra,
  };
}

/**
 * 统一坐标区留白。ECharts 6 已废弃 `grid.containLabel`：不注册
 * LegacyGridContainLabel 时它是空操作（控制台会提示改用 outerBounds），
 * 这里用官方等价写法 `outerBoundsMode: 'same' + outerBoundsContain: 'axisLabel'`
 * 保证窄面板不裁切轴标签。
 */
export const CHART_GRID_CONTAIN_LABEL = {
  outerBoundsMode: 'same',
  outerBoundsContain: 'axisLabel',
} as const;

export function getChartGrid(overrides?: Partial<{
  left: number; right: number; top: number; bottom: number;
}>) {
  return {
    left: 10,
    right: 18,
    top: 36,
    bottom: 8,
    ...CHART_GRID_CONTAIN_LABEL,
    ...overrides,
  };
}

/** 图表 hover 强调用的柔和阴影，统一数值来源。 */
export function getChartEmphasisShadow(alpha = 0.35) {
  return { shadowBlur: 14, shadowColor: `rgba(0, 0, 0, ${alpha})` };
}

/**
 * 统一动画默认值（5.5 图表规格）：首次渲染 700ms cubicOut，数据更新 450ms；
 * reduceMotion 由调用方传入（每次从 `getChartThemeTokens().reduceMotion`
 * 实时读取，不在这里缓存），关闭时整体禁用动画而不是把时长压到 0——ECharts
 * 在 `animation:false` 下才会真正跳过首帧的位移/透明度补间。
 */
export function getChartAnimation(reduceMotion: boolean) {
  return {
    animation: !reduceMotion,
    animationDuration: 700,
    animationDurationUpdate: 450,
    animationEasing: 'cubicOut' as const,
    animationEasingUpdate: 'cubicOut' as const,
  };
}

function hexToRgbTuple(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return null;
  const int = parseInt(match[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

/**
 * 把令牌色值（约定为 6 位 hex，见 design-tokens 契约）转成带透明度的
 * rgba()，用于图表渐变的色阶插值。传入非 hex 值时原样返回，不抛错。
 */
export function withAlpha(color: string, alpha: number): string {
  const rgb = hexToRgbTuple(color);
  if (!rgb) return color;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/**
 * 柱状图共享样式：顶部（竖向）或右侧（横向）圆角 + 同色纵向/横向渐变，统一
 * `barMaxWidth` 上限，避免单一类目把柱子撑成整块色板（5.5 图表规格）。
 * 面板仍可在展开结果上覆盖 `barMaxWidth` 或合并到每个数据点自己的
 * `itemStyle` 里（如需按数据点分别取色）。
 */
export function barSeriesStyle(
  color: string,
  orientation: 'vertical' | 'horizontal' = 'vertical',
  /**
   * Gradient alpha stops `[near-axis, far-axis]`. Default keeps the existing
   * 0.96 → 0.74 fade (5.5 图表规格) for rank/series bars. A caller drawing a
   * *tool identity* colour in the light theme should pass a higher floor
   * (T10.178 review P2-2, root R-9): several `--chart-N` colours drop under
   * the 3:1 contrast floor once composited at 0.74 on a white panel, and an
   * identity colour must stay recognisably itself, not just "a colour".
   * Passing this does not touch `tokens.css` or the default for any other
   * bar chart (device distribution, behaviour-page daily/hourly bars).
   */
  alphaStops: readonly [number, number] = [0.96, 0.74],
) {
  const isVertical = orientation === 'vertical';
  return {
    itemStyle: {
      color: {
        type: 'linear' as const,
        x: 0,
        y: 0,
        x2: isVertical ? 0 : 1,
        y2: isVertical ? 1 : 0,
        colorStops: [
          { offset: 0, color: withAlpha(color, alphaStops[0]) },
          { offset: 1, color: withAlpha(color, alphaStops[1]) },
        ],
      },
      borderRadius: isVertical ? [6, 6, 2, 2] : [0, 6, 6, 0],
    },
    barMaxWidth: 36,
  };
}

/**
 * 折线图面积渐变：线条色从 `topAlpha`（默认约 22%）渐隐到全透明（5.5 图表
 * 规格）。返回可直接赋给 `series[i].areaStyle.color` 的 ECharts 线性渐变。
 */
export function lineAreaGradient(color: string, topAlpha = 0.22) {
  return {
    type: 'linear' as const,
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: withAlpha(color, topAlpha) },
      { offset: 1, color: withAlpha(color, 0) },
    ],
  };
}
