import type { AppSettings, RangeKey } from '../types';
import type { QuotaWindowHighlight } from './quotaOverview';

/**
 * 桌面挂件的内容配置（T10.124）。
 *
 * 桌面端有两块挂件：托盘挂件是"我主动去看一眼"，桌面小组件是"它一直在那儿"。
 * 两者用途不同，因此各自持有一份配置，对齐 Android 的每实例 `WidgetConfig`
 * （`mode / providerId / range / theme`）。取值是闭合集合，Rust 的
 * `settings.rs` 用同一组字符串，两端都以"未知即回落到默认"为准。
 */

export type WidgetSurface = 'popover' | 'desktop';
export type WidgetLayout = 'usage' | 'combo' | 'quota' | 'compact' | 'routing';
export type WidgetThemeMode = 'system' | 'light' | 'dark';
/** 挂件只提供主看板范围的一个子集；写成 `Extract` 是为了两边不会各自漂移。 */
export type WidgetRange = Extract<RangeKey, 'today' | 'week' | 'month'>;

export interface WidgetConfig {
  layout: WidgetLayout;
  theme: WidgetThemeMode;
  range: WidgetRange;
  /** null = 自动挑最吃紧的一条窗口；否则只看这个来源。 */
  providerId: string | null;
}

export const WIDGET_LAYOUTS: ReadonlyArray<{
  id: WidgetLayout;
  label: string;
  description: string;
}> = [
  { id: 'usage', label: '用量详情', description: '大数字 + 走势 + 构成 + 最紧额度' },
  { id: 'combo', label: '额度与用量', description: '额度在上，用量在下' },
  { id: 'quota', label: '额度总览', description: '只看额度，按吃紧程度排列' },
  { id: 'compact', label: '单行消耗', description: '只有大数字与预估费用' },
  { id: 'routing', label: '实时路由', description: 'Agent → 网关 → 上游，失败切换实时可见' },
];

// 主题三个取值的名字已经说尽了它们的行为，不再配 description：
// 下拉框里写着「跟随系统」，旁边再写一行「随系统深浅色切换」只是重复。
export const WIDGET_THEMES: ReadonlyArray<{ id: WidgetThemeMode; label: string }> = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
];

export const WIDGET_RANGES: ReadonlyArray<{
  id: WidgetRange;
  label: string;
  previous: string;
}> = [
  { id: 'today', label: '今日', previous: '昨日同期' },
  { id: 'week', label: '本周', previous: '上周同期' },
  { id: 'month', label: '本月', previous: '上月同期' },
];

/**
 * 托盘悬停的停留时长（T10.125）。托盘图标只有十几像素宽，去点旁边的图标、
 * 去右下角看时间都会从它上面扫过；没有停留判定就变成"路过即弹出"。
 * 数值单位是毫秒，与 Rust 的 `HOVER_SHOW_DELAY_MS` / `TRAY_HOVER_DELAY_MAX_MS` 对齐。
 */
export const TRAY_HOVER_DELAY_CHOICES: ReadonlyArray<{
  ms: number;
  label: string;
  hint: string;
}> = [
  { ms: 0, label: '立即弹出', hint: '鼠标路过也会弹出' },
  { ms: 250, label: '轻快（0.25 秒）', hint: '略作停留才弹出' },
  { ms: 450, label: '标准（0.45 秒）', hint: '路过基本不会误触' },
  { ms: 900, label: '从容（0.9 秒）', hint: '要明确停住才弹出' },
];

export const TRAY_HOVER_DELAY_MAX_MS = 2000;
export const DEFAULT_TRAY_HOVER_DELAY_MS = 450;

/** 手改过的设置文件可能给出任意数字；夹回合法区间，非数字回落默认。 */
export function parseTrayHoverDelay(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TRAY_HOVER_DELAY_MS;
  return Math.min(Math.max(Math.round(value), 0), TRAY_HOVER_DELAY_MAX_MS);
}

export const DEFAULT_WIDGET_CONFIG: WidgetConfig = {
  layout: 'usage',
  theme: 'system',
  range: 'today',
  providerId: null,
};

function parseFrom<T extends string>(
  options: ReadonlyArray<{ id: T }>,
  value: unknown,
  fallback: T,
): T {
  return options.some((option) => option.id === value) ? (value as T) : fallback;
}

export const parseWidgetLayout = (value: unknown): WidgetLayout =>
  parseFrom(WIDGET_LAYOUTS, value, DEFAULT_WIDGET_CONFIG.layout);
export const parseWidgetThemeMode = (value: unknown): WidgetThemeMode =>
  parseFrom(WIDGET_THEMES, value, DEFAULT_WIDGET_CONFIG.theme);
export const parseWidgetRange = (value: unknown): WidgetRange =>
  parseFrom(WIDGET_RANGES, value, DEFAULT_WIDGET_CONFIG.range);

interface WidgetSettingKeys {
  layout: 'widget_popover_layout' | 'widget_desktop_layout';
  theme: 'widget_popover_theme' | 'widget_desktop_theme';
  range: 'widget_popover_range' | 'widget_desktop_range';
  provider: 'widget_popover_provider' | 'widget_desktop_provider';
}

/** 设置键按形态成组，调用方不必在四个地方各拼一次字符串。 */
export function widgetSettingKeys(surface: WidgetSurface): WidgetSettingKeys {
  return surface === 'desktop'
    ? {
        layout: 'widget_desktop_layout',
        theme: 'widget_desktop_theme',
        range: 'widget_desktop_range',
        provider: 'widget_desktop_provider',
      }
    : {
        layout: 'widget_popover_layout',
        theme: 'widget_popover_theme',
        range: 'widget_popover_range',
        provider: 'widget_popover_provider',
      };
}

export function widgetConfigFromSettings(
  settings: Partial<AppSettings> | null | undefined,
  surface: WidgetSurface,
): WidgetConfig {
  if (!settings) return { ...DEFAULT_WIDGET_CONFIG };
  const keys = widgetSettingKeys(surface);
  const provider = settings[keys.provider];
  return {
    layout: parseWidgetLayout(settings[keys.layout]),
    theme: parseWidgetThemeMode(settings[keys.theme]),
    range: parseWidgetRange(settings[keys.range]),
    providerId: typeof provider === 'string' && provider.trim() ? provider : null,
  };
}

/** `system` 跟随系统；显式选择永远压过系统偏好。 */
export function resolveWidgetTheme(mode: WidgetThemeMode, prefersLight: boolean): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode;
  return prefersLight ? 'light' : 'dark';
}

export interface WidgetQuotaSelection {
  highlights: QuotaWindowHighlight[];
  /** 钉住了某个来源、但当前一条都读不到。 */
  pinnedMissing: boolean;
}

/**
 * 按配置挑出要显示的额度窗口。
 *
 * 钉住的来源读不到时返回空集合并置 `pinnedMissing`，由界面显示"这个来源现在读不到"。
 * 不做"回退成全部来源"——Android 的 `widgetLayoutProviders` 正是用 `?: providers`
 * 兜底，结果钉在单一来源上的小组件在该来源掉线后开始显示别人的额度，
 * 用户完全看不出换了对象。
 */
export function selectWidgetQuota(
  highlights: readonly QuotaWindowHighlight[],
  providerId: string | null,
): WidgetQuotaSelection {
  if (!providerId) return { highlights: [...highlights], pinnedMissing: false };
  const matched = highlights.filter((item) => item.providerId === providerId);
  return { highlights: matched, pinnedMissing: matched.length === 0 };
}
