#!/usr/bin/env node
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputArg = process.argv.indexOf('--output');
const outputRoot = path.resolve(outputArg >= 0 ? process.argv[outputArg + 1] : path.join(root, 'artifacts', 'T10.223-share-templates'));
if (outputArg >= 0 && !process.argv[outputArg + 1]) throw new Error('--output requires a path');

const require = createRequire(import.meta.url);
const canvasEntry = require.resolve('@napi-rs/canvas');
const { createCanvas, GlobalFonts, Image, Path2D } = await import(pathToFileURL(canvasEntry).href);
const scratch = mkdtempSync(path.join(tmpdir(), 'tokenledger-share-render-'));
const bundleDir = path.join(scratch, 'bundle');
const assetDir = path.join(scratch, 'assets');
mkdirSync(bundleDir, { recursive: true });

try {
  await build({
    entryPoints: [path.join(root, 'src/utils/shareCardRenderer.ts')],
    outfile: path.join(bundleDir, 'shareCardRenderer.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'warning',
  });

  for (const relative of [
    'share-backgrounds/liquid-archive.png',
    'share-icons/calendar-days.svg',
    'share-icons/chart-pie.svg',
    'share-icons/piggy-bank.svg',
  ]) {
    const source = path.join(root, 'src/assets', relative);
    const destination = path.join(assetDir, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination);
  }

  const fonts = path.join(root, 'src/assets/fonts/share');
  for (const [file, family] of [
    ['noto_sans_sc_400.woff2', 'TokenLedger Share Sans'],
    ['noto_sans_sc_500.woff2', 'TokenLedger Share Sans'],
    ['noto_sans_sc_700.woff2', 'TokenLedger Share Sans'],
    ['noto_sans_sc_900.woff2', 'TokenLedger Share Sans'],
    ['roboto_condensed_900.woff2', 'TokenLedger Share Number'],
    ['lxgw_wenkai_regular.woff2', 'TokenLedger Share Journal Hand'],
    ['zhi_mang_xing_regular.woff2', 'TokenLedger Share Receipt Hand'],
    ['fusion_pixel_12_proportional.woff2', 'TokenLedger Share Receipt Pixel'],
  ]) GlobalFonts.registerFromPath(path.join(fonts, file), family);
  for (const cjkPath of ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc']) {
    if (existsSync(cjkPath)) GlobalFonts.registerFromPath(cjkPath, 'Noto Sans CJK SC');
  }

  class NodeImage extends Image {
    set src(value) {
      super.src = typeof value === 'string' && value.startsWith('file:') ? fileURLToPath(value) : value;
    }
    get src() { return super.src; }
  }
  globalThis.Image = NodeImage;
  globalThis.Path2D = Path2D;
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') throw new Error(`Unexpected document.createElement(${tag})`);
      return createCanvas(1, 1);
    },
  };

  const renderer = await import(`${pathToFileURL(path.join(bundleDir, 'shareCardRenderer.mjs')).href}?run=${Date.now()}`);
  await renderer.ensureShareCardAssetsReady('scorecard');

  const commonTools = {
    claude: { name: 'Claude Code', input: 3_600_000, output: 2_160_000, cached: 1_000_000, total: 5_760_000, cost: 18, requests: 300 },
    codex: { name: 'Codex CLI', input: 2_900_000, output: 1_580_000, cached: 800_000, total: 4_480_000, cost: 15, requests: 220 },
    gemini: { name: 'Gemini CLI', input: 1_700_000, output: 680_000, cached: 600_000, total: 2_380_000, cost: 9.5, requests: 120 },
  };
  const commonModels = {
    claude: { ...commonTools.claude, name: 'Claude Opus 4.1' },
    codex: { ...commonTools.codex, name: 'gpt-5.6-sol' },
    gemini: { ...commonTools.gemini, name: 'Gemini 2.5 Pro' },
  };
  const days = Object.fromEntries(Array.from({ length: 18 }, (_, index) => [`2026-09-${String(index + 1).padStart(2, '0')}`, (index + 1) * 55_000]));
  const baseSummary = {
    totalTokens: 12_800_000, inputTokens: 8_200_000, outputTokens: 4_600_000,
    cachedTokens: 2_400_000, cacheReadTokens: 2_200_000, cacheWriteTokens: 200_000,
    totalCost: 42.5, cacheSavedUsd: 12.8, totalRequests: 640, avgTokensPerReq: 20_000,
  };
  const comparison = {
    window: {
      kind: 'monthOverMonth', timezone: 'Asia/Shanghai', bucket: 'day',
      currentStart: '2026-09-01T00:00:00+08:00', currentEnd: '2026-09-30T23:59:59+08:00',
      previousStart: '2026-08-01T00:00:00+08:00', previousEnd: '2026-08-31T23:59:59+08:00',
      alignedThrough: '2026-09-30T23:59:59+08:00',
    },
    current: { summary: baseSummary, series: [] },
    previous: { summary: { ...baseSummary, totalTokens: 13_400_000, inputTokens: 8_600_000, outputTokens: 4_800_000 }, series: [] },
    delta: {
      tokens: { absolute: -600_000, percent: 4.5, direction: 'down' },
      requests: { absolute: -28, percent: 4.2, direction: 'down' },
      cost: { absolute: -2.4, percent: 5.3, direction: 'down' },
    },
  };
  const normal = {
    summary: baseSummary, tools: commonTools, models: commonModels, trends: [], heatmap: days,
    history: [], comparison, meta: { generatedAt: '2026-09-30T18:00:00+08:00', timezone: 'Asia/Shanghai' },
  };
  const stressName = '超长中文模型名-Reasoning-Preview-2026-Enterprise-Edition';
  const stressSummary = {
    ...baseSummary, totalTokens: 999_999_999, inputTokens: 800_000_001, outputTokens: 199_999_998,
    cachedTokens: 88_888_888, cacheReadTokens: 80_000_000, cacheWriteTokens: 8_888_888,
    totalRequests: 999_999, totalCost: 9999.99, cacheSavedUsd: 0,
  };
  const stress = {
    summary: stressSummary,
    tools: { long: { ...commonTools.claude, name: stressName, total: 999_999_999, input: 800_000_001, output: 199_999_998, cached: 88_888_888, requests: 999_999 } },
    models: { long: { ...commonModels.claude, name: stressName, total: 999_999_999, input: 800_000_001, output: 199_999_998, cached: 88_888_888, requests: 999_999 } },
    trends: [], heatmap: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`2026-09-${String(index + 1).padStart(2, '0')}`, 33_333_333])),
    history: [], comparison: {
      ...comparison,
      current: { summary: stressSummary, series: [] },
      previous: { summary: { ...stressSummary, totalTokens: 1_100_000_000, inputTokens: 880_000_000, outputTokens: 220_000_000 }, series: [] },
      delta: {
        tokens: { absolute: -100_000_001, percent: 9.1, direction: 'down' },
        requests: { absolute: -1, percent: 0.1, direction: 'down' },
        cost: { absolute: -1, percent: 0.1, direction: 'down' },
      },
    },
    meta: { generatedAt: '2026-09-30T18:00:00+08:00', timezone: 'Asia/Shanghai', stale: true },
  };

  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(path.join(outputRoot, 'production', 'normal'), { recursive: true });
  mkdirSync(path.join(outputRoot, 'production', 'stress'), { recursive: true });
  mkdirSync(path.join(outputRoot, 'delivery', 'normal'), { recursive: true });
  mkdirSync(path.join(outputRoot, 'delivery', 'stress'), { recursive: true });
  const outputs = [];
  for (const [scenario, stats, hideCosts] of [['normal', normal, false], ['stress', stress, true]]) {
    for (const layout of Object.keys(renderer.SHARE_LAYOUTS)) {
      await renderer.ensureShareCardAssetsReady(layout);
      const canvas = renderer.renderShareCardToCanvas({
        stats, range: 'month', scope: scenario === 'normal' ? 'local' : 'cloud', layout,
        hideCosts, appVersion: '1.2.77', now: new Date('2026-09-30T18:00:00+08:00'),
      });
      const filename = `${layout}${scenario === 'stress' ? '-stress' : ''}.png`;
      const productionRelative = `production/${scenario}/${filename}`;
      const productionPng = await canvas.encode('png');
      writeFileSync(path.join(outputRoot, productionRelative), productionPng);

      const context = canvas.getContext('2d');
      context.save();
      context.fillStyle = 'rgba(5, 10, 18, .84)';
      context.fillRect(438, 12, 204, 46);
      context.fillStyle = '#ffffff';
      context.font = '700 26px "TokenLedger Share Sans", "Noto Sans CJK SC", sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText('演示数据', 540, 35);
      context.restore();
      const deliveryRelative = `delivery/${scenario}/${filename}`;
      const deliveryPng = await canvas.encode('png');
      writeFileSync(path.join(outputRoot, deliveryRelative), deliveryPng);

      outputs.push({
        scenario, layout, width: canvas.width, height: canvas.height, hideCosts,
        production: { file: productionRelative, bytes: productionPng.byteLength, sha256: createHash('sha256').update(productionPng).digest('hex') },
        delivery: { file: deliveryRelative, bytes: deliveryPng.byteLength, sha256: createHash('sha256').update(deliveryPng).digest('hex'), watermark: '演示数据' },
      });
    }
  }
  const art = readFileSync(path.join(root, 'src/assets/share-backgrounds/liquid-archive.png'));
  const manifest = {
    generatedAt: '2026-09-30T18:00:00+08:00',
    renderer: 'src/utils/shareCardRenderer.ts#renderShareCardToCanvas',
    canvasImplementation: '@napi-rs/canvas (offline Canvas 2D; production PNGs call the same renderer, delivery copies add only an evidence watermark)',
    size: { width: 1080, height: 1920 },
    scenarios: {
      normal: '12.8M effective tokens, 640 records, 18 active days, costs visible',
      stress: '999,999,999 effective tokens, 999,999 records, long CJK model/tool name, negative comparison, stale cloud snapshot, costs hidden',
    },
    fixedArt: { file: 'src/assets/share-backgrounds/liquid-archive.png', textFree: true, sha256: createHash('sha256').update(art).digest('hex') },
    outputs,
  };
  writeFileSync(path.join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ outputRoot, productionRendered: outputs.length, deliveryWatermarked: outputs.length, width: 1080, height: 1920 }, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
