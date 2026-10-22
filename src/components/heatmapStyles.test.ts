// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';

// 年度日历与节奏格的样式契约（T10.161 修正轮）。vitest 配置了 css: false，`?raw` 导入会被清空；
// 工程也没装 @types/node，所以用变量说明符动态导入 node:fs 读原文（node 环境下 import.meta.url 才是 file: 地址）。
let css = '';

beforeAll(async () => {
  const fsModule = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
    readFileSync(path: URL, encoding: 'utf8'): string;
  };
  css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
});

/** 取出所有 `@media (forced-colors: active) { … }` 块的正文（按花括号配对）。 */
function forcedColorBlocks(source: string): string[] {
  const blocks: string[] = [];
  const opener = /@media\s*\(forced-colors:\s*active\)\s*\{/g;
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

/** 块内的规则：选择器与声明。 */
function rulesOf(block: string): Array<{ selector: string; body: string }> {
  return [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.replace(/\/\*[\s\S]*?\*\//g, '').trim(),
    body,
  }));
}

const SYSTEM_COLORS = /^(Canvas|CanvasText|GrayText|Highlight|HighlightText|ButtonText|ButtonFace|ButtonBorder|LinkText|VisitedText|ActiveText|Mark|MarkText|Field|FieldText|AccentColor|AccentColorText|SelectedItem|SelectedItemText)$/;

describe('年度日历与节奏格的强制色彩规则', () => {
  it('每种状态只用系统色：不出现十六进制、rgb()、color-mix()、var() 或半透明', () => {
    const rules = forcedColorBlocks(css)
      .flatMap(rulesOf)
      .filter(({ selector }) => /heatmap-cell|\.heat-|rhythm-(cell|legend)/.test(selector));
    expect(rules.length).toBeGreaterThan(5);

    for (const { selector, body } of rules) {
      for (const declaration of body.split(';').map((part) => part.trim()).filter(Boolean)) {
        const [property, ...rest] = declaration.split(':');
        const value = rest.join(':').trim();
        expect(value, `${selector} → ${declaration}`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix\(|var\(/i);
        if (property.trim() === 'opacity') expect(Number(value), `${selector} → ${declaration}`).toBe(1);
        if (/^(background|border-color|color)$/.test(property.trim())) {
          expect(value, `${selector} → ${declaration}`).toMatch(SYSTEM_COLORS);
        }
        if (/^(box-shadow|outline)$/.test(property.trim()) && value !== 'none') {
          const colorWord = value.split(/\s+/).find((word) => /^[A-Z][A-Za-z]+$/.test(word));
          expect(colorWord ?? '', `${selector} → ${declaration}`).toMatch(SYSTEM_COLORS);
        }
      }
    }
  });

  it('档位规则带 [data-level]，与上方 color-mix 色阶同特异性且写在其后，1–2 档不会漏出非系统色', () => {
    const rampIndex = css.indexOf(".rhythm-cell[data-level='1'],");
    const forcedBase = forcedColorBlocks(css)
      .flatMap(rulesOf)
      .find(({ selector }) => selector.includes('.rhythm-cell[data-level]'));
    expect(rampIndex).toBeGreaterThan(-1);
    expect(forcedBase, '强制色彩基础规则需要 .rhythm-cell[data-level]').toBeDefined();
    expect(forcedBase?.selector).toContain('.rhythm-legend i[data-level]');
    expect(forcedBase?.selector).toContain('.heatmap-cell[data-level]');
    expect(css.indexOf('.rhythm-cell[data-level],')).toBeGreaterThan(rampIndex);
  });
});

describe('节奏格浅档的非颜色线索（T10.181）', () => {
  it('1–2 档带 1px 主色内框，写在色阶之后；进行中的警示内框与强制色彩规则都排在它后面', () => {
    // 主色对面板 ≥4.5:1 由 frontend-contracts 的主题对比度用例守着，这里只守规则本身和先后顺序。
    const ring = css.match(/\.rhythm-cell\[data-level='1'\],\s*\.rhythm-cell\[data-level='2'\],\s*\.rhythm-legend i\[data-level='1'\],\s*\.rhythm-legend i\[data-level='2'\] \{ box-shadow: inset 0 0 0 1px var\(--color-primary\); \}/);
    expect(ring, '1–2 档的主色内框规则').not.toBeNull();
    const at = ring?.index ?? -1;
    expect(at).toBeGreaterThan(css.indexOf(".rhythm-legend i[data-level='5'] { background: var(--color-primary)"));
    expect(at).toBeLessThan(css.indexOf('.rhythm-cell.is-in-progress {'));
    expect(at).toBeLessThan(css.indexOf('.rhythm-cell[data-level],'));
  });

  it('浅色第 3 档也带 1px 主色内框（R-46）：主题前缀包在 :where() 里，不压过进行中内框与强制色彩规则', () => {
    const ring = css.match(/:where\(:root\[data-theme="light"\]\) \.rhythm-cell\[data-level='3'\],\s*:where\(:root\[data-theme="light"\]\) \.rhythm-legend i\[data-level='3'\] \{ box-shadow: inset 0 0 0 1px var\(--color-primary\); \}/);
    expect(ring, '浅色第 3 档的主色内框规则').not.toBeNull();
    const at = ring?.index ?? -1;
    expect(at).toBeGreaterThan(css.indexOf(".rhythm-legend i[data-level='5'] { background: var(--color-primary)"));
    expect(at).toBeLessThan(css.indexOf('.rhythm-cell.is-in-progress {'));
    expect(at).toBeLessThan(css.indexOf('.rhythm-cell[data-level],'));
    // 深色第 3 档对面板 3.06:1 已达标：除了这条浅色规则，别处不给第 3 档加主色内框。
    const tierThreeRings = [...css.matchAll(/([^{}]*\[data-level='3'\][^{}]*)\{[^{}]*box-shadow: inset 0 0 0 1px var\(--color-primary\)/g)];
    expect(tierThreeRings).toHaveLength(1);
  });
});

describe('年度日历浅档的非颜色线索（T10.206）', () => {
  it('1–2 档带 1px --color-text-faint 内框（不是节奏格用的主色），写在色阶之后、进行中与强制色彩规则之前', () => {
    // --color-text-faint 对两端面板 ≥3:1 已由 .heat-unknown 斜纹线的同一变量验证过（见下方常规样式测试）。
    const ring = css.match(/\.heatmap-cell\[data-level='1'\],\s*\.heatmap-cell\[data-level='2'\] \{ box-shadow: inset 0 0 0 1px var\(--color-text-faint\); \}/);
    expect(ring, '年度日历 1–2 档的 --color-text-faint 内框规则').not.toBeNull();
    const at = ring?.index ?? -1;
    expect(at).toBeGreaterThan(css.indexOf(".rhythm-legend i[data-level='5'] { background: var(--color-primary)"));
    // index.css 里 @media (forced-colors: active) 不止一处（更早处理 .heatmap-cell 的
    // 0/未查询/未来态）；要比较的是紧跟在这条新规则之后、给档位色阶配系统色的那一处，从
    // `at` 之后找起，不是从文件最开头找起。
    expect(at).toBeLessThan(css.indexOf('@media (forced-colors: active)', at));
  });

  it('浅色第 3 档也带同一圈 --color-text-faint 内框；深色第 3 档 3.06:1 已达标，不加任何内框', () => {
    const ring = css.match(/:where\(:root\[data-theme="light"\]\) \.heatmap-cell\[data-level='3'\] \{ box-shadow: inset 0 0 0 1px var\(--color-text-faint\); \}/);
    expect(ring, '年度日历浅色第 3 档的 --color-text-faint 内框规则').not.toBeNull();
    // 日历第 3 档任何地方都不应该借用节奏格那套主色内框（会被读成第 5 档实心块的空心版）。
    const heatmapTierThreeWithPrimaryRing = [...css.matchAll(/([^{}]*\.heatmap-cell\[data-level='3'\][^{}]*)\{[^{}]*box-shadow: inset 0 0 0 1px var\(--color-primary\)/g)];
    expect(heatmapTierThreeWithPrimaryRing).toHaveLength(0);
  });
});

describe('年度日历的常规样式', () => {
  it('不支持 color-mix 时的实色兜底写在色阶之前，支持时由色阶覆盖', () => {
    const fallback = css.indexOf('.heatmap-cell[data-level] { background: var(--color-primary); }');
    const ramp = css.indexOf(".heatmap-cell[data-level='1'],");
    expect(fallback).toBeGreaterThan(-1);
    expect(ramp).toBeGreaterThan(fallback);
  });

  it('未查询的斜纹线用对面板 ≥3:1 的 --color-text-faint（P2-3）', () => {
    expect(css).toMatch(/\.heat-unknown\s*\{\s*background:\s*repeating-linear-gradient\(-45deg,\s*var\(--color-text-faint\) 0 1px, transparent 1px 4px\);\s*\}/);
  });
});
