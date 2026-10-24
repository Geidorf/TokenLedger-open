import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRAY_HOVER_DELAY_MS,
  DEFAULT_WIDGET_CONFIG,
  TRAY_HOVER_DELAY_CHOICES,
  TRAY_HOVER_DELAY_MAX_MS,
  TRAY_TEXT_METRICS,
  WIDGET_LAYOUTS,
  WIDGET_RANGES,
  WIDGET_THEMES,
  parseTrayHoverDelay,
  parseTrayTextMetric,
  parseWidgetLayout,
  parseWidgetRange,
  parseWidgetThemeMode,
  resolveWidgetTheme,
  selectWidgetQuota,
  widgetConfigFromSettings,
  widgetSettingKeys,
} from './widgetConfig';
import type { QuotaWindowHighlight } from './quotaOverview';

function highlight(providerId: string, remaining: number): QuotaWindowHighlight {
  return {
    providerId,
    providerName: providerId,
    windowId: 'five-hour',
    windowLabel: '5 小时',
    remaining,
    status: 'ok',
    level: remaining < 20 ? 'critical' : remaining < 50 ? 'warn' : 'ok',
  };
}

describe('widgetConfig', () => {
  it('未知取值一律回落到默认，不留空白也不抛错', () => {
    // 设置文件可能来自更新的版本、也可能被手改过；渲染时再兜底就得写四遍。
    expect(parseWidgetLayout('compact')).toBe('compact');
    expect(parseWidgetLayout('multi_ring')).toBe(DEFAULT_WIDGET_CONFIG.layout);
    expect(parseWidgetLayout(undefined)).toBe('usage');
    expect(parseWidgetThemeMode('light')).toBe('light');
    expect(parseWidgetThemeMode(null)).toBe('system');
    expect(parseWidgetRange('month')).toBe('month');
    expect(parseWidgetRange('year')).toBe('today');
  });

  it('合法取值与 Rust 侧的闭合集合逐字对齐', () => {
    // settings.rs 的 WIDGET_LAYOUTS / WIDGET_THEMES / WIDGET_RANGES 是同一组字符串，
    // 两端任何一边加了取值而另一边没加，都会在这里显形。
    expect(WIDGET_LAYOUTS.map((item) => item.id)).toEqual(['usage', 'combo', 'quota', 'compact', 'routing', 'panel']);
    expect(TRAY_TEXT_METRICS.map((item) => item.id)).toEqual(['cost', 'quota']);
    expect(parseTrayTextMetric('quota')).toBe('quota');
    expect(parseTrayTextMetric('tokens')).toBe('cost');
    expect(parseTrayTextMetric(undefined)).toBe('cost');
    expect(WIDGET_THEMES.map((item) => item.id)).toEqual(['system', 'light', 'dark']);
    expect(WIDGET_RANGES.map((item) => item.id)).toEqual(['today', 'week', 'month']);
  });

  it('两块挂件各读各的设置键，互不串台', () => {
    expect(widgetSettingKeys('popover').layout).toBe('widget_popover_layout');
    expect(widgetSettingKeys('desktop').layout).toBe('widget_desktop_layout');
    const settings = {
      widget_popover_layout: 'compact',
      widget_popover_theme: 'dark',
      widget_popover_range: 'week',
      widget_popover_provider: 'anthropic-claude-consumer',
      widget_desktop_layout: 'quota',
      widget_desktop_theme: 'light',
      widget_desktop_range: 'month',
      widget_desktop_provider: null,
    };
    expect(widgetConfigFromSettings(settings, 'popover')).toEqual({
      layout: 'compact',
      theme: 'dark',
      range: 'week',
      providerId: 'anthropic-claude-consumer',
    });
    expect(widgetConfigFromSettings(settings, 'desktop')).toEqual({
      layout: 'quota',
      theme: 'light',
      range: 'month',
      providerId: null,
    });
  });

  it('读不到设置时给默认配置，空白来源等价于不钉住', () => {
    // 托盘挂件的默认板式是「托盘面板」（与 Rust DEFAULT_POPOVER_LAYOUT 一致），桌面小组件仍是「用量详情」。
    expect(widgetConfigFromSettings(null, 'popover')).toEqual({ ...DEFAULT_WIDGET_CONFIG, layout: 'panel' });
    expect(widgetConfigFromSettings(null, 'desktop')).toEqual(DEFAULT_WIDGET_CONFIG);
    expect(widgetConfigFromSettings({ widget_popover_layout: 'future' }, 'popover').layout).toBe('panel');
    expect(widgetConfigFromSettings({ widget_desktop_layout: 'future' }, 'desktop').layout).toBe('usage');
    expect(widgetConfigFromSettings({ widget_popover_provider: '  ' }, 'popover').providerId).toBeNull();
  });

  it('显式选择的主题压过系统偏好，跟随系统才看 prefers-color-scheme', () => {
    expect(resolveWidgetTheme('light', false)).toBe('light');
    expect(resolveWidgetTheme('dark', true)).toBe('dark');
    expect(resolveWidgetTheme('system', true)).toBe('light');
    expect(resolveWidgetTheme('system', false)).toBe('dark');
  });

  it('悬停停留时长夹在合法区间内，非数字回落默认', () => {
    // 0 是合法值：它表示恢复旧的「立即弹出」，不是「没设置」。
    expect(parseTrayHoverDelay(0)).toBe(0);
    expect(parseTrayHoverDelay(250)).toBe(250);
    expect(parseTrayHoverDelay(-1)).toBe(0);
    expect(parseTrayHoverDelay(99_999)).toBe(TRAY_HOVER_DELAY_MAX_MS);
    expect(parseTrayHoverDelay(null)).toBe(DEFAULT_TRAY_HOVER_DELAY_MS);
    expect(parseTrayHoverDelay('450')).toBe(DEFAULT_TRAY_HOVER_DELAY_MS);
    expect(parseTrayHoverDelay(Number.NaN)).toBe(DEFAULT_TRAY_HOVER_DELAY_MS);
    // 默认值必须是给出的选项之一，否则下拉框打开就是「自定义」。
    expect(TRAY_HOVER_DELAY_CHOICES.some((item) => item.ms === DEFAULT_TRAY_HOVER_DELAY_MS)).toBe(true);
  });

  it('不钉来源时给全部窗口，顺序不动', () => {
    const all = [highlight('a', 10), highlight('b', 40)];
    const selection = selectWidgetQuota(all, null);
    expect(selection.highlights).toEqual(all);
    expect(selection.pinnedMissing).toBe(false);
  });

  it('钉住的来源读不到时给空集合并报缺，绝不改显示别人的额度', () => {
    // Android 的 widgetLayoutProviders 用 `?: providers` 兜底，结果钉在单一来源上的
    // 小组件在该来源掉线后开始显示别人的额度，用户完全看不出换了对象。
    const all = [highlight('a', 10), highlight('b', 40)];
    expect(selectWidgetQuota(all, 'b')).toEqual({ highlights: [highlight('b', 40)], pinnedMissing: false });
    const missing = selectWidgetQuota(all, 'c');
    expect(missing.highlights).toEqual([]);
    expect(missing.pinnedMissing).toBe(true);
  });
});
