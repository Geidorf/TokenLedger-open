import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getChartGrid,
  getChartThemeTokens,
  getChartTooltip,
  getChartEmphasisShadow,
  getChartAnimation,
  barSeriesStyle,
  lineAreaGradient,
  withAlpha,
} from './chartTheme';

describe('chartTheme', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    vi.restoreAllMocks();
  });

  it('caches computed-style reads per data-theme and invalidates synchronously when the attribute flips', () => {
    const spy = vi.spyOn(window, 'getComputedStyle');
    document.documentElement.setAttribute('data-theme', 'dark');
    getChartThemeTokens();
    const readsAfterFirstPaint = spy.mock.calls.length;
    expect(readsAfterFirstPaint).toBeGreaterThan(0);

    // Same theme: every further call must be served from the cache.
    getChartThemeTokens();
    getChartThemeTokens();
    expect(spy.mock.calls.length).toBe(readsAfterFirstPaint);

    // Theme switch: useTheme writes data-theme synchronously before re-render,
    // so the next call has to re-read the tokens.
    document.documentElement.setAttribute('data-theme', 'light');
    getChartThemeTokens();
    expect(spy.mock.calls.length).toBeGreaterThan(readsAfterFirstPaint);
  });

  it('accepts the effective theme as an explicit cache identity for memoized chart options', () => {
    const spy = vi.spyOn(window, 'getComputedStyle');
    document.documentElement.setAttribute('data-theme', 'dark');
    getChartThemeTokens('dark');
    const darkReads = spy.mock.calls.length;
    getChartThemeTokens('dark');
    expect(spy.mock.calls.length).toBe(darkReads);
    getChartThemeTokens('light');
    expect(spy.mock.calls.length).toBeGreaterThan(darkReads);
  });

  it('reduceMotion is re-read every call instead of frozen into the theme cache', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    // jsdom has no matchMedia; stub it and flip the response between calls.
    const stub = (matches: boolean) => ({
      value: ((query: string) => ({
        matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, 'matchMedia', stub(true));
    try {
      const first = getChartThemeTokens();
      expect(first.reduceMotion).toBe(true);
      Object.defineProperty(window, 'matchMedia', stub(false));
      const second = getChartThemeTokens();
      expect(second.reduceMotion).toBe(false);
    } finally {
      Reflect.deleteProperty(window, 'matchMedia');
    }
  });

  it('tooltips merge custom config over the shared surface and keep pointer-events none', () => {
    const tokens = getChartThemeTokens();
    const tooltip = getChartTooltip(tokens, { trigger: 'axis', formatter: () => 'x' });
    expect((tooltip as { trigger?: string }).trigger).toBe('axis');
    expect(tooltip.backgroundColor).toBe(tokens.bgOverlay);
    expect(tooltip.borderColor).toBe(tokens.borderStrong);
    expect(tooltip.extraCssText).toContain('pointer-events: none;');
    expect(tooltip.extraCssText).toContain('border-radius: 12px;');
  });

  it('grid overrides win over defaults and axis labels stay contained (ECharts 6 outerBounds)', () => {
    const grid = getChartGrid({ left: 42, bottom: 0 });
    expect(grid.left).toBe(42);
    expect(grid.bottom).toBe(0);
    expect(grid.right).toBe(18);
    // ECharts 6 ignores the legacy `containLabel` unless LegacyGridContainLabel
    // is registered; the runtime never registers it, so the grid must use the
    // official equivalent instead of silently losing label containment.
    expect(grid.outerBoundsMode).toBe('same');
    expect(grid.outerBoundsContain).toBe('axisLabel');
    expect('containLabel' in grid).toBe(false);
  });

  it('emphasis shadow is a shared numeric source', () => {
    expect(getChartEmphasisShadow()).toEqual({ shadowBlur: 14, shadowColor: 'rgba(0, 0, 0, 0.35)' });
    expect(getChartEmphasisShadow(0.2).shadowColor).toBe('rgba(0, 0, 0, 0.2)');
  });

  it('tooltip surface reads the shared shadow token and keeps tabular numerals', () => {
    // jsdom never resolves real stylesheet values for getComputedStyle, so this
    // checks the wiring (tooltip pulls tokens.shadowFloat/pointer-events, adds
    // tabular-nums) rather than a literal color, which the design-tokens test
    // suite already covers against the compiled CSS.
    document.documentElement.setAttribute('data-theme', 'dark');
    const tokens = getChartThemeTokens();
    expect(tokens.shadowFloat.length).toBeGreaterThan(0);
    const tooltip = getChartTooltip(tokens);
    expect(tooltip.extraCssText).toContain('font-variant-numeric: tabular-nums;');
    expect(tooltip.extraCssText).toContain(`box-shadow: ${tokens.shadowFloat};`);
  });

  it('exposes the --chart-1…8 series palette on the token object', () => {
    const tokens = getChartThemeTokens();
    expect(tokens.seriesPalette).toHaveLength(8);
    tokens.seriesPalette.forEach((color) => expect(color.length).toBeGreaterThan(0));
  });

  // T10.150 motion-bug regression: getChartThemeTokens() used to spread a
  // fresh object literal on every call (`{ ...cachedTokens, reduceMotion }`),
  // so any panel that put the result in a useMemo dependency array rebuilt
  // its chart option on every unrelated re-render (BehaviorAnalysisView's
  // five charts). Tokens must now keep one stable reference per theme +
  // reduceMotion combination, and only produce a new reference when either
  // actually changes.
  it('keeps a referentially stable token object across calls with the same theme and reduceMotion', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const first = getChartThemeTokens();
    const second = getChartThemeTokens();
    const third = getChartThemeTokens('dark');
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('returns a new token reference when the theme flips', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const dark = getChartThemeTokens();
    document.documentElement.setAttribute('data-theme', 'light');
    const light = getChartThemeTokens();
    expect(light).not.toBe(dark);
    // Settling back on 'dark' within the same test is itself stable again.
    document.documentElement.setAttribute('data-theme', 'dark');
    const darkAgain = getChartThemeTokens();
    expect(getChartThemeTokens()).toBe(darkAgain);
  });

  it('returns a new token reference when only reduceMotion flips', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const stub = (matches: boolean) => ({
      value: ((query: string) => ({
        matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, 'matchMedia', stub(false));
    try {
      const calm = getChartThemeTokens();
      Object.defineProperty(window, 'matchMedia', stub(true));
      const reduced = getChartThemeTokens();
      expect(reduced).not.toBe(calm);
      expect(reduced.reduceMotion).toBe(true);
      expect(calm.reduceMotion).toBe(false);
      // Settling on "reduced" is itself stable across further unrelated calls.
      expect(getChartThemeTokens()).toBe(reduced);
    } finally {
      Reflect.deleteProperty(window, 'matchMedia');
    }
  });

  it('getChartAnimation disables animation only when reduceMotion is true, with the shared 700/450ms timings', () => {
    expect(getChartAnimation(false)).toEqual({
      animation: true,
      animationDuration: 700,
      animationDurationUpdate: 450,
      animationEasing: 'cubicOut',
      animationEasingUpdate: 'cubicOut',
    });
    expect(getChartAnimation(true).animation).toBe(false);
  });

  it('withAlpha converts a 6-digit hex token into an rgba() string and passes through non-hex input', () => {
    expect(withAlpha('#6b9dff', 0.5)).toBe('rgba(107, 157, 255, 0.5)');
    expect(withAlpha('rgba(1,2,3,0.4)', 0.5)).toBe('rgba(1,2,3,0.4)');
  });

  it('barSeriesStyle rounds the leading edge per orientation and caps barMaxWidth', () => {
    const vertical = barSeriesStyle('#6b9dff');
    expect(vertical.itemStyle.borderRadius).toEqual([6, 6, 2, 2]);
    expect(vertical.itemStyle.color.x2).toBe(0);
    expect(vertical.itemStyle.color.y2).toBe(1);
    expect(vertical.barMaxWidth).toBe(36);

    const horizontal = barSeriesStyle('#6b9dff', 'horizontal');
    expect(horizontal.itemStyle.borderRadius).toEqual([0, 6, 6, 0]);
    expect(horizontal.itemStyle.color.x2).toBe(1);
    expect(horizontal.itemStyle.color.y2).toBe(0);
  });

  it('lineAreaGradient fades from ~22% opacity at the line to fully transparent', () => {
    const gradient = lineAreaGradient('#6b9dff');
    expect(gradient.colorStops[0].color).toBe('rgba(107, 157, 255, 0.22)');
    expect(gradient.colorStops[1].color).toBe('rgba(107, 157, 255, 0)');
  });
});
