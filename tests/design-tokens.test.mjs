import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { compile } from '@tailwindcss/node';
import { parse } from 'postcss';

test('编译后的设计令牌不产生自引用，圆角保留可解析值', async () => {
  const css = await readFile(path.resolve('src/index.css'), 'utf8');
  const compiler = await compile(css, { base: path.resolve('src'), onDependency: () => {} });
  const output = parse(compiler.build(['rounded-md', 'shadow-sm', 'bg-primary', 'text-secondary', 'text-warning', 'p-4']));
  const cycles = [];
  output.walkDecls(/^--/, (declaration) => {
    if (declaration.value.trim() === `var(${declaration.prop})`) cycles.push(declaration.prop);
  });
  assert.deepEqual(cycles, []);
  const mediumRadius = [];
  output.walkDecls('--radius-md', (declaration) => { mediumRadius.push(declaration.value); });
  assert.equal(mediumRadius.at(-1), '8px');
  const warningColors = [];
  output.walkRules('.text-warning', (rule) => {
    rule.walkDecls('color', (declaration) => warningColors.push(declaration.value));
  });
  assert.deepEqual(warningColors, ['var(--color-warning)'], '主题切换必须在运行时解析语义色');
});

// T10.245: source/token assertions belong in the existing Node contract gate.
// These checks do not prove rendered cascade, disabled colors, or pixel contrast.
function apiPrimaryButtonLuminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map((value) => {
    const channel = Number.parseInt(value, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}

for (const theme of ['dark', 'light']) {
  test(`API 主按钮 ${theme} 启用态 token 对比至少 4.5:1`, async () => {
    const tokens = await readFile(path.resolve('src/styles/tokens.css'), 'utf8');
    const selector = theme === 'dark' ? ':root[data-theme="auto"]' : ':root[data-theme="light"]';
    const block = tokens.slice(tokens.indexOf(selector + ' {')).split('}')[0];
    const token = (name) => block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))[1];
    const fill = apiPrimaryButtonLuminance(token('--color-primary-fill'));
    const foreground = apiPrimaryButtonLuminance(token('--color-text-on-primary'));
    assert.ok((Math.max(fill, foreground) + .05) / (Math.min(fill, foreground) + .05) >= 4.5);
  });
}

// T10.251: keep filesystem-based CSS contracts in this Node gate, not src TS tests.
// This checks source layout rules only; two-size browser pixel QA remains separate.
test('模型排行快捷入口按可用宽度换行，名称与数值保留独立可读列', async () => {
  const css = await readFile(path.resolve('src/index.css'), 'utf8');
  const list = css.match(/\.chart-access-list \{([^}]+)\}/)?.[1] ?? '';
  assert.ok(list.includes('display: grid'));
  assert.ok(list.includes('grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr))'));
  assert.ok(list.includes('overflow-x: visible'));
  const button = css.match(/\.chart-access-list button \{([^}]+)\}/)?.[1] ?? '';
  assert.ok(button.includes('grid-template-columns: minmax(0, 1fr) max-content'));
  assert.ok(button.includes('min-height: 44px'));
});

// Multi-row model shortcuts can stretch the shared grid row. Keep the donut
// canvas bounded by its own width so its 30% x-center cannot clip the 78% ring.
test('相邻模型卡增高时，工具圆环画布按宽度约束并保留 hover 半径空间', async () => {
  const css = await readFile(path.resolve('src/index.css'), 'utf8');
  const rule = css.match(/\.tool-distribution-panel:not\(\.is-compact\) \.chart-fill \{([^}]+)\}/)?.[1] ?? '';
  assert.ok(rule.includes('aspect-ratio: 3 / 2'));
  assert.ok(rule.includes('flex: 0 1 auto'));
  assert.ok(rule.includes('margin-block: auto'));
  // Mac regression: 385x377 canvas had outer radius 147.03, x-center 115.5.
  assert.ok(Math.min(385, 377) * .78 / 2 > 385 * .30);
  for (const width of [300, 385, 500]) {
    for (const availableHeight of [210, 247, 377, 600]) {
      const height = Math.min(availableHeight, width * 2 / 3);
      const radius = Math.min(width, height) * .78 / 2 + 5;
      assert.ok(radius <= width * .30, `left edge fits at ${width}x${height}`);
      assert.ok(radius <= height * .48, `bottom edge fits at ${width}x${height}`);
    }
  }
});


test('实体嵌套导航独占header一行，长标题不与导航和操作挤在同一行', async () => {
  const css = await readFile(path.resolve('src/index.css'), 'utf8');
  const block = (selector) => {
    const declarations = [];
    parse(css).walkRules((rule) => {
      if (rule.selector === selector) rule.walkDecls((decl) => declarations.push(`${decl.prop}: ${decl.value}`));
    });
    return declarations.join('; ');
  };
  assert.ok(block('.entity-modal-header').includes('flex-wrap: wrap'));
  assert.ok(block('.entity-modal-header').includes('min-width: 0'));
  assert.ok(block('.entity-breadcrumb-nav').includes('flex: 0 0 100%'));
  assert.ok(block('.entity-breadcrumb-nav').includes('min-width: 0'));
  assert.ok(block('.entity-breadcrumb-nav').includes('max-width: 100%'));
  assert.ok(block('.entity-modal-heading').includes('flex: 1 1 20rem'));
  assert.ok(block('.entity-modal-heading > div').includes('min-width: 0'));
  assert.ok(block('.entity-modal-actions').includes('flex: 0 0 auto'));
  // Desktop flex-basis must not become a tall heading in the existing mobile column.
  let mobileReset = false;
  parse(css).walkAtRules('media', (media) => {
    if (media.params !== '(max-width: 860px)') return;
    media.walkRules((rule) => {
      if (rule.selector.includes('.entity-modal-heading') && rule.selector.includes('.entity-breadcrumb-nav')) {
        rule.walkDecls('flex', (decl) => { if (decl.value === '0 1 auto') mobileReset = true; });
      }
    });
  });
  assert.ok(mobileReset);
});
