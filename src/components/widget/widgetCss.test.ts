// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { TRAY_BAR_EXTRA, widgetCardSize } from './cardModel';

// 挂件卡片的样式契约（T10.192）。vitest 配置了 css: false，`?raw` 导入会被清空；
// 工程也没装 @types/node，所以用变量说明符动态导入 node:fs 读原文（写法同 heatmapStyles.test.ts）。
let css = '';

beforeAll(async () => {
  const fsModule = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
    readFileSync(path: URL, encoding: 'utf8'): string;
  };
  css = readFileSync(new URL('../../styles/widget.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
});

/** `@media (…) { … }` 块的正文（按花括号配对）。 */
function mediaBlocks(source: string, query: string): string[] {
  const blocks: string[] = [];
  const opener = new RegExp(`@media\\s*\\(${query.replace(/[()]/g, '\\$&')}\\)\\s*\\{`, 'g');
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    let depth = 1;
    let index = match.index + match[0].length;
    while (depth > 0 && index < source.length) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}') depth -= 1;
      index += 1;
    }
    blocks.push(source.slice(match.index + match[0].length, index - 1));
  }
  return blocks;
}

/** 去掉所有 @media 块后剩下的顶层规则。 */
function topLevel(source: string): string {
  let result = source;
  for (let start = result.indexOf('@media'); start >= 0; start = result.indexOf('@media')) {
    let index = result.indexOf('{', start) + 1;
    let depth = 1;
    while (depth > 0 && index < result.length) {
      if (result[index] === '{') depth += 1;
      else if (result[index] === '}') depth -= 1;
      index += 1;
    }
    result = result.slice(0, start) + result.slice(index);
  }
  return result;
}

interface Rule { selectors: string[]; decls: Map<string, string> }

function rulesOf(block: string): Rule[] {
  return [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selectors: selector.split(',').map((part) => part.trim().replace(/\s+/g, ' ')),
    decls: new Map(body.split(';').map((decl) => decl.trim()).filter(Boolean).map((decl) => {
      const colon = decl.indexOf(':');
      return [decl.slice(0, colon).trim(), decl.slice(colon + 1).trim()] as [string, string];
    })),
  }));
}

/** 顶层里选择器恰好是 `selector` 的那条规则的声明（同一选择器多条时合并，后写的覆盖先写的）。 */
function decl(selector: string, property: string): string | undefined {
  let value: string | undefined;
  for (const rule of rulesOf(topLevel(css))) {
    if (rule.selectors.includes(selector) && rule.decls.has(property)) value = rule.decls.get(property);
  }
  return value;
}

const px = (value: string | undefined) => Number(/^(-?\d+(?:\.\d+)?)px$/.exec(value ?? '')?.[1] ?? Number.NaN);

describe('桌面小组件悬停工具条（方案 §6.6，U-18）', () => {
  it('平时隐藏（透明且 visibility: hidden，点不到），指针移入 120ms 淡入', () => {
    expect(decl('.wl-toolbar', 'opacity')).toBe('0');
    expect(decl('.wl-toolbar', 'visibility')).toBe('hidden');
    expect(decl('.wl-toolbar', 'transition')).toMatch(/^opacity 120ms ease-out, visibility 0s linear 120ms$/);
    expect(decl(".wl-toolbar[data-shown='true']", 'opacity')).toBe('1');
    expect(decl(".wl-toolbar[data-shown='true']", 'visibility')).toBe('visible');
    expect(decl(".wl-toolbar[data-shown='true']", 'transition')).toMatch(/^opacity 120ms ease-out, visibility 0s linear 0s$/);
  });

  it('工具条盖住的那一行（「更新于」）同时淡出，不留两层字叠在一起', () => {
    expect(decl(".widget-root[data-toolbar='shown'] .wl-under-toolbar", 'opacity')).toBe('0');
    expect(decl('.wl-under-toolbar', 'transition')).toBe('opacity 120ms ease-out');
  });

  it('减弱动效时直接出现：工具条、被盖住的一行与按钮都不做过渡', () => {
    const blocks = mediaBlocks(css, 'prefers-reduced-motion: reduce');
    expect(blocks).toHaveLength(1);
    const rules = rulesOf(blocks[0]);
    for (const selector of ['.wl-toolbar', ".wl-toolbar[data-shown='true']", '.wl-under-toolbar', '.wl-icon-btn', '.wl-seg-btn']) {
      expect(rules.some((rule) => rule.selectors.includes(selector) && rule.decls.get('transition') === 'none')).toBe(true);
    }
  });
});

describe('命中区与焦点（GLB-03）', () => {
  it('图标视觉 30px，伪元素把命中区扩到 44×44；相邻图标间距 14px，命中区相接不重叠', () => {
    expect(px(decl('.wl-icon-btn', 'width'))).toBe(30);
    expect(px(decl('.wl-icon-btn', 'height'))).toBe(30);
    const inset = px(decl('.wl-icon-btn::after', 'inset'));
    expect(30 - 2 * inset).toBe(44);
    // 顶栏里的图标命中区向上扩到窗口顶边：上 12 + 下 2，高仍是 44。
    expect(30 - px(decl('.wl-bar .wl-icon-btn::after', 'top')) - px(decl('.wl-bar .wl-icon-btn::after', 'bottom'))).toBe(44);
    expect(30 + px(decl('.wl-icons', 'gap'))).toBe(44);
    expect(30 + px(decl('.wl-toolbar', 'gap'))).toBe(44);
  });

  it('范围分段至少 44 宽，26 高的按钮向上 14、向下 4 扩到 44 高', () => {
    expect(px(decl('.wl-seg-btn', 'min-width'))).toBe(44);
    const height = px(decl('.wl-seg-btn', 'height'));
    expect(height - px(decl('.wl-seg-btn::after', 'top')) - px(decl('.wl-seg-btn::after', 'bottom'))).toBe(44);
  });

  it('托盘挂件的按钮有看得见的焦点环', () => {
    expect(decl('.widget-root button:focus-visible', 'outline')).toBe('2px solid var(--wl-ok)');
  });
});

describe('颜色（方案 §6.3）', () => {
  it('浅色卡片不透明；深色默认不透明，只在 macOS 托盘挂件降到 90%', () => {
    expect(decl('.widget-root', '--wl-bg')).toBe('#0e1116');
    expect(decl(".widget-root[data-card-theme='light']", '--wl-bg')).toBe('#ffffff');
    // 画卡片底色的规则（选择器最后一段是 .widget-root 本身）：半透明只许出现在深色，且不低于 90%。
    const surfaces = rulesOf(topLevel(css)).flatMap((rule) => rule.selectors
      .filter((selector) => /\.widget-root(\[[^\]]+\])*(:[a-z-]+)?$/.test(selector) && rule.decls.has('background'))
      .map((selector) => ({ selector, background: rule.decls.get('background')! })));
    expect(surfaces.length).toBeGreaterThan(0);
    for (const { selector, background } of surfaces) {
      if (background === 'var(--wl-bg)') continue;
      const alpha = /rgba\([^)]*,\s*([\d.]+)\)$/.exec(background)?.[1];
      expect(selector, `${selector} → ${background}`).toContain("[data-card-theme='dark']");
      expect(Number(alpha)).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('额度环只用 primary / warning / danger 三色，历史快照改轴线灰；环心与大数字不染色', () => {
    expect(decl('.wl-ring-arc', 'stroke')).toBe('var(--wl-ok)');
    expect(decl(".wl-ring[data-level='warn'] .wl-ring-arc", 'stroke')).toBe('var(--wl-warn)');
    expect(decl(".wl-ring[data-level='critical'] .wl-ring-arc", 'stroke')).toBe('var(--wl-danger)');
    expect(decl(".wl-ring[data-stale='true'] .wl-ring-arc", 'stroke')).toBe('var(--wl-axis)');
    const arcRules = rulesOf(topLevel(css)).filter((rule) => rule.selectors.some((selector) => selector.endsWith('.wl-ring-arc')) && rule.decls.has('stroke'));
    expect(new Set(arcRules.map((rule) => rule.decls.get('stroke')))).toEqual(new Set(['var(--wl-ok)', 'var(--wl-warn)', 'var(--wl-danger)', 'var(--wl-axis)']));
    expect(decl('.wl-num', 'color')).toBe('var(--wl-text)');
    expect(decl('.wl-ring-num', 'color')).toBe('var(--wl-text)');
    const levelColoured = rulesOf(topLevel(css)).filter((rule) => rule.selectors.some((selector) => /data-level/.test(selector) && /wl-(ring-)?num/.test(selector)));
    expect(levelColoured).toEqual([]);
  });
});

describe('尺寸（方案 §6.4）', () => {
  it.each(['usage', 'combo', 'quota', 'compact'] as const)('「%s」卡片高度与 §6.4 的桌面小组件高度一致', (layout) => {
    expect(px(decl(`.widget-root[data-layout='${layout}']`, '--wl-card-h'))).toBe(widgetCardSize('desktop', layout).height);
  });

  it('托盘挂件 = 顶栏 42px 替掉卡片顶部 16px 内边距，整体高 26px', () => {
    expect(px(decl('.wl-bar', 'height')) - 16).toBe(TRAY_BAR_EXTRA);
    expect(decl(".widget-root[data-mode='popover'] .wl-card", 'height')).toBe('calc(var(--wl-card-h, 100%) - 16px)');
    expect(decl('.wl-card', 'padding')).toBe('16px 18px');
  });
});
