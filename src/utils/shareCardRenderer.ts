import type { DataScope, RangeKey, StatsData } from '../types';
import { formatEstimatedUsd, formatNum, formatTokens } from './format';
import { buildShareSummary, type ShareLayoutKey, type ShareSummary } from './shareSummary';
import { TOKEN_LEDGER_PATH, TOKEN_LEDGER_SIZE, TOKEN_LEDGER_STROKE_WIDTH } from '../components/brand/tokenLedgerGeometry';

const liquidArchiveBackgroundUrl = new URL('../assets/share-backgrounds/liquid-archive.png', import.meta.url).href;
export const SHARE_METRIC_ICON_ASSETS = [
  { key: 'calendar-days', url: new URL('../assets/share-icons/calendar-days.svg', import.meta.url).href },
  { key: 'chart-pie', url: new URL('../assets/share-icons/chart-pie.svg', import.meta.url).href },
  { key: 'piggy-bank', url: new URL('../assets/share-icons/piggy-bank.svg', import.meta.url).href },
] as const;

export const SHARE_BACKGROUND_ASSETS = [{ key: 'liquid-archive', url: liquidArchiveBackgroundUrl }] as const;

export { type ShareLayoutKey } from './shareSummary';

export const SHARE_CARD_WIDTH = 1080;
export const SHARE_CARD_HEIGHT = 1920;
const JOURNAL_EMPTY_TREND_COPY = '当前周期暂无可证明的分桶趋势';
const MIN_SHARE_TEXT_SIZE = 24;

export interface ShareCardOptions {
  stats: StatsData;
  range: RangeKey;
  scope: DataScope;
  layout?: ShareLayoutKey;
  hideCosts?: boolean;
  appVersion?: string;
  now?: Date;
}

export const SHARE_LAYOUTS = {
  // Keep the five historical IDs stable so persisted selections remain valid.
  scorecard: { name: '编辑宣言', description: '数据海报 · 赤黑大字', accent: '#ff1f1f' },
  journal: { name: 'AI 搭子', description: '协作手记 · 彩色几何', accent: '#064cff' },
  achievement: { name: '流光档案', description: '连续成就 · 深蓝液态', accent: '#cce8ff' },
  receipt: { name: '月度通行证', description: '协作结算单 · 热粉票根', accent: '#ff3f9c' },
  signal: { name: '像素存档', description: '极简信号 · 鼠尾草像素', accent: '#0b3427' },
} satisfies Record<ShareLayoutKey, { name: string; description: string; accent: string }>;

export interface ShareSceneRegion { id: string; x: number; y: number; width: number; height: number }
export interface ShareCardScene {
  width: typeof SHARE_CARD_WIDTH;
  height: typeof SHARE_CARD_HEIGHT;
  layout: ShareLayoutKey;
  summary: ShareSummary;
  regions: ShareSceneRegion[];
  keyTexts: string[];
}

const LAYOUT_REGIONS: Record<ShareLayoutKey, ShareSceneRegion[]> = {
  scorecard: [
    { id: 'masthead', x: 42, y: 42, width: 996, height: 206 }, { id: 'type-riot', x: 42, y: 280, width: 930, height: 370 },
    { id: 'hero', x: 42, y: 684, width: 930, height: 404 }, { id: 'facts', x: 42, y: 1118, width: 986, height: 222 },
    { id: 'composition', x: 42, y: 1360, width: 986, height: 354 }, { id: 'footer', x: 42, y: 1774, width: 996, height: 118 },
  ],
  journal: [
    { id: 'masthead', x: 40, y: 20, width: 1000, height: 394 }, { id: 'blue-orbit', x: 0, y: 408, width: 590, height: 584 },
    { id: 'lime-stair', x: 630, y: 250, width: 450, height: 760 }, { id: 'pink-tile', x: 270, y: 965, width: 810, height: 525 },
    { id: 'hero', x: 36, y: 1480, width: 996, height: 252 }, { id: 'footer', x: 42, y: 1774, width: 996, height: 118 },
  ],
  achievement: [
    { id: 'masthead', x: 40, y: 40, width: 1000, height: 246 }, { id: 'active-days', x: 260, y: 300, width: 560, height: 310 },
    { id: 'liquid-art', x: 40, y: 620, width: 1000, height: 730 }, { id: 'facts', x: 60, y: 1400, width: 960, height: 306 },
    { id: 'footer', x: 42, y: 1774, width: 996, height: 118 },
  ],
  receipt: [
    { id: 'ticket-head', x: 72, y: 40, width: 936, height: 428 }, { id: 'record-hero', x: 96, y: 492, width: 888, height: 488 },
    { id: 'facts', x: 96, y: 1000, width: 888, height: 284 }, { id: 'tear-off', x: 0, y: 1382, width: 1080, height: 378 },
    { id: 'footer', x: 42, y: 1780, width: 996, height: 118 },
  ],
  signal: [
    { id: 'masthead', x: 52, y: 42, width: 976, height: 304 }, { id: 'hero', x: 52, y: 360, width: 976, height: 560 },
    { id: 'pixel-world', x: 0, y: 820, width: 1080, height: 580 }, { id: 'archive-rows', x: 52, y: 1440, width: 976, height: 318 },
    { id: 'footer', x: 42, y: 1780, width: 996, height: 118 },
  ],
};

export function buildShareCardScene(options: ShareCardOptions): ShareCardScene {
  const layout = options.layout || 'scorecard';
  const summary = buildShareSummary({ stats: options.stats, range: options.range, scope: options.scope, hideCosts: options.hideCosts, now: options.now });
  const keyTexts = [summary.title, summary.periodLabel, formatTokens(summary.effectiveTokens), summary.insight, SHARE_LAYOUTS[layout].name, summary.sourceLabel];
  if (summary.isStale) keyTexts.push('缓存快照');
  if (layout === 'journal' && summary.series.length === 0) keyTexts.push(JOURNAL_EMPTY_TREND_COPY);
  // T10.169: expose the leader share text at the scene level (in the exact
  // "占 X%" form `drawScorecard` paints) for every layout, not just the one
  // that currently draws it on canvas — the underlying `summary` is shared
  // across all 5 layouts, so this is the one place a test can assert the
  // rounding/clamping fix reaches every poster variant.
  if (summary.topTool && summary.topTool.sharePercent !== null) keyTexts.push(`占 ${summary.topTool.sharePercent}%`);
  if (summary.topModel && summary.topModel.sharePercent !== null) keyTexts.push(`占 ${summary.topModel.sharePercent}%`);
  return {
    width: SHARE_CARD_WIDTH, height: SHARE_CARD_HEIGHT, layout, summary,
    regions: LAYOUT_REGIONS[layout].map((region) => ({ ...region })),
    keyTexts,
  };
}

type Palette = { bg: string; fg: string; muted: string; faint: string; accent: string; secondary: string; line: string };
export const SHARE_FONT_FAMILIES = {
  // Bundled faces cover the poster's fixed copy. The explicit CJK fallback keeps
  // arbitrary user-provided tool/model names readable when a glyph is absent.
  sans: '"TokenLedger Share Sans", "Noto Sans CJK SC", sans-serif',
  number: '"TokenLedger Share Number", "TokenLedger Share Sans", "Noto Sans CJK SC", sans-serif',
  journalHand: '"TokenLedger Share Journal Hand", "TokenLedger Share Sans", "Noto Sans CJK SC", sans-serif',
  receiptHand: '"TokenLedger Share Receipt Hand", "TokenLedger Share Sans", "Noto Sans CJK SC", sans-serif',
  receiptPixel: '"TokenLedger Share Receipt Pixel", "TokenLedger Share Sans", "Noto Sans CJK SC", sans-serif',
} as const;

const FONT_SANS = SHARE_FONT_FAMILIES.sans;
const FONT_NUMBER = SHARE_FONT_FAMILIES.number;
const FONT_JOURNAL_HAND = SHARE_FONT_FAMILIES.journalHand;
const FONT_RECEIPT_HAND = SHARE_FONT_FAMILIES.receiptHand;
const FONT_RECEIPT_PIXEL = SHARE_FONT_FAMILIES.receiptPixel;

export interface ShareTextRole {
  family: string;
  size: number;
  weight: number;
  tracking: number;
  lineHeight: number;
}

function textRole(family: string, size: number, weight: number, tracking = 0, lineHeight = 1): ShareTextRole {
  return { family, size, weight, tracking, lineHeight };
}

export const SHARE_TYPOGRAPHY = {
  scorecard: {
    title: textRole(FONT_SANS, 188, 900, -5), hero: textRole(FONT_NUMBER, 360, 900, -12),
    heroLabel: textRole(FONT_SANS, 68, 900), factValue: textRole(FONT_NUMBER, 138, 900, -4), footer: textRole(FONT_SANS, 44, 800),
  },
  journal: {
    title: textRole(FONT_SANS, 122, 900, -4), hero: textRole(FONT_NUMBER, 202, 900, -6),
    insight: textRole(FONT_SANS, 54, 900), footer: textRole(FONT_SANS, 54, 800),
  },
  achievement: {
    title: textRole(FONT_SANS, 72, 700, 3), stack: textRole(FONT_SANS, 48, 700, 4),
    day: textRole(FONT_NUMBER, 270, 700, -8), dayUnit: textRole(FONT_SANS, 48, 700, 4),
    token: textRole(FONT_NUMBER, 142, 700, -5), footer: textRole(FONT_SANS, 54, 700),
  },
  receipt: {
    titleLatin: textRole(FONT_NUMBER, 138, 900, -5), titleCjk: textRole(FONT_SANS, 138, 900, -5),
    hero: textRole(FONT_NUMBER, 390, 900, -12), row: textRole(FONT_SANS, 38, 900),
    insight: textRole(FONT_SANS, 44, 900), footer: textRole(FONT_SANS, 56, 800),
  },
  signal: {
    title: textRole(FONT_SANS, 124, 900, -4), hero: textRole(FONT_RECEIPT_PIXEL, 284, 400, -3),
    factValue: textRole(FONT_RECEIPT_PIXEL, 166, 400, -2), footer: textRole(FONT_SANS, 54, 700),
  },
} satisfies Record<ShareLayoutKey, Record<string, ShareTextRole>>;

export const SHARE_HERO_RENDERING = {
  scorecard: 'uniform-fit', journal: 'uniform-fit', achievement: 'uniform-fit', receipt: 'uniform-fit', signal: 'uniform-fit',
} as const satisfies Record<ShareLayoutKey, 'uniform-fit' | 'fit-height-compress-x'>;

export const SHARE_TEXT_FIT_MODES = {
  scorecard: { title: 'exact-box', hero: 'exact-box' },
  journal: { title: 'exact-box', hero: 'exact-box' },
  achievement: { title: 'exact-box', day: 'exact-box' },
  receipt: { title: 'exact-box', hero: 'exact-box' },
  signal: { title: 'exact-box', hero: 'exact-box' },
} as const;

export const SHARE_FOOTER_ANCHORS = {
  scorecard: { brand: [158, 1830, 234, 39], iconX: 78, dividerY: 1796, metaTop: 1838, centered: false },
  journal: { brand: [147, 1816, 290, 49], iconX: 78, dividerY: 1780, metaTop: 1825, centered: false },
  achievement: { brand: [156, 1828, 303, 47], iconX: 78, dividerY: 1784, metaTop: 1837, centered: false },
  receipt: { brand: [164, 1810, 357, 58], iconX: 78, dividerY: 1782, metaTop: 1872, centered: false },
  signal: { brand: [432, 1810, 304, 58], iconX: 352, dividerY: 1782, metaTop: 1872, centered: true },
} as const satisfies Record<ShareLayoutKey, { brand: ShareVisualBox; iconX: number; dividerY: number; metaTop: number; centered: boolean }>;

export const SHARE_LAYOUT_ANCHORS = {
  scorecard: { factsHeadingTop: 1392, factsLabelTop: 1472, factsValueTop: 1518, leaderLabelTop: 1656, leaderValueTop: 1656, compositionTop: 1518 },
  journal: { factsLabelTop: 1682, factsValueTop: 1480, leaderLabelTop: 560, leaderValueTop: 660, leaderCenters: [292, 865] },
  achievement: { cards: [60, 1400, 960, 306] },
  receipt: { period: [650, 78, 300, 54], cardsHeader: [106, 1434, 430, 58], cards: [106, 1518, 868, 240] },
  signal: { facts: [52, 1440, 976, 318], composition: [52, 1668, 976, 70] },
} as const;

export type ShareVisualBox = readonly [x: number, y: number, width: number, height: number];
export const SHARE_TEXT_BOXES = {
  scorecard: { title: [52, 280, 680, 328], period: [58, 132, 420, 50], hero: [48, 684, 870, 330], heroLabel: [56, 1000, 580, 82] },
  journal: { title: [48, 218, 790, 118], period: [54, 128, 440, 46], heroLeft: [36, 660, 510, 180], heroRight: [660, 690, 380, 152], insight: [350, 1050, 610, 268] },
  achievement: { title: [170, 148, 740, 76], stackFirst: [278, 300, 524, 238], stackSecond: [360, 548, 360, 62], giantDay: [278, 300, 524, 238], functionalDay: [360, 548, 360, 62], token: [68, 1408, 430, 142] },
  receipt: { title: [90, 225, 900, 132], hero: [120, 500, 840, 340], rows: [106, 1518, 868, 240] },
  signal: { title: [66, 140, 790, 118], period: [650, 50, 360, 46], hero: [54, 368, 974, 250] },
} satisfies Record<ShareLayoutKey, Record<string, ShareVisualBox>>;

export const SHARE_PAINT_CALIBRATION_BOXES = SHARE_TEXT_BOXES;

export function getAchievementCardPositions(requestedCount: number) {
  const count = Math.min(7, Math.max(1, Math.floor(requestedCount)));
  const cardWidth = 126;
  const step = count > 1 ? (count < 7 ? (968 - cardWidth) / (count - 1) : 138) : 0;
  const groupWidth = cardWidth + Math.max(0, count - 1) * step;
  const startX = 56 + (968 - groupWidth) / 2;
  return Array.from({ length: count }, (_, index) => startX + index * step);
}

export const SHARE_FONT_LOAD_SPECS = [
  { font: `400 24px ${FONT_SANS}`, sample: '数据来自本机账本' },
  { font: `500 24px ${FONT_SANS}`, sample: '有效 Token' },
  { font: `700 24px ${FONT_SANS}`, sample: '我的 AI 协作周报' },
  { font: `900 24px ${FONT_SANS}`, sample: '连续协作结算单' },
  { font: `900 24px ${FONT_NUMBER}`, sample: '1.28M 0123456789' },
  { font: `400 24px ${FONT_JOURNAL_HAND}`, sample: '每天都留下了一段协作轨迹' },
  { font: `400 24px ${FONT_RECEIPT_HAND}`, sample: '这周，我和 AI 并肩作战了 7 天' },
  { font: `400 24px ${FONT_RECEIPT_PIXEL}`, sample: '01 8/16 Codex CLI GPT-5' },
] as const;

let shareBaseAssetsReady: Promise<void> | null = null;
let liquidArchiveReady: Promise<void> | null = null;
let liquidArchiveBackground: HTMLImageElement | null = null;
const shareMetricImages = new Map<string, HTMLImageElement>();

function loadShareMetricIcon(key: string, url: string): Promise<void> {
  if (typeof Image === 'undefined') return Promise.resolve();
  if (shareMetricImages.get(key)?.complete) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => { shareMetricImages.set(key, image); resolve(); };
    image.onerror = () => reject(new Error(`Failed to load the ${key} share poster icon`));
    image.src = url;
  });
}

function loadLiquidArchiveBackground(): Promise<void> {
  if (typeof Image === 'undefined') return Promise.resolve();
  if (liquidArchiveBackground?.complete) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => { liquidArchiveBackground = image; resolve(); };
    image.onerror = () => reject(new Error('Failed to load the liquid archive share poster background'));
    image.src = liquidArchiveBackgroundUrl;
  });
}

export function ensureShareCardAssetsReady(layout: ShareLayoutKey = 'scorecard'): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  if (!shareBaseAssetsReady) {
    const fontSet = document.fonts;
    shareBaseAssetsReady = Promise.all([
      ...(fontSet ? SHARE_FONT_LOAD_SPECS.map(({ font: value, sample }) => fontSet.load(value, sample)) : []),
      ...SHARE_METRIC_ICON_ASSETS.map(({ key, url }) => loadShareMetricIcon(key, url)),
    ]).then(async () => {
      if (!fontSet) return;
      await fontSet.ready;
      const missing = SHARE_FONT_LOAD_SPECS.filter(({ font: value, sample }) => !fontSet.check(value, sample));
      if (missing.length) throw new Error(`Failed to load ${missing.length} share poster font role(s)`);
    }).catch((error) => {
      shareBaseAssetsReady = null;
      throw error;
    });
  }
  if (layout !== 'achievement') return shareBaseAssetsReady;
  if (!liquidArchiveReady) {
    liquidArchiveReady = loadLiquidArchiveBackground().catch((error) => {
      liquidArchiveReady = null;
      throw error;
    });
  }
  return Promise.all([shareBaseAssetsReady, liquidArchiveReady]).then(() => undefined);
}

export const ensureShareCardFontsReady = ensureShareCardAssetsReady;

function font(size: number, weight: number | string = 500, family: string = FONT_SANS) { return `${weight} ${size}px ${family}`; }
function setText(ctx: CanvasRenderingContext2D, color: string, size: number, weight: number | string = 500, family: string = FONT_SANS) {
  ctx.fillStyle = color; ctx.font = font(size, weight, family); ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  if ('fontKerning' in ctx) ctx.fontKerning = 'normal';
}
function trackedWidth(ctx: CanvasRenderingContext2D, text: string, tracking = 0) {
  return visibleMetrics(ctx, text, tracking).width;
}
function useTextRole(ctx: CanvasRenderingContext2D, color: string, role: ShareTextRole) {
  ctx.fillStyle = color; ctx.font = font(role.size, role.weight, role.family); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  if ('fontKerning' in ctx) ctx.fontKerning = 'normal';
}
function drawTrackedAtBaseline(ctx: CanvasRenderingContext2D, text: string, x: number, baseline: number, tracking: number) {
  if (!tracking) { ctx.fillText(text, x, baseline); return; }
  let cursor = x;
  Array.from(text).forEach((glyph) => { ctx.fillText(glyph, cursor, baseline); cursor += ctx.measureText(glyph).width + tracking; });
}
function horizontalTextBounds(metrics: TextMetrics) {
  const advance = Number.isFinite(metrics.width) ? Math.max(0, metrics.width) : 0;
  const inkLeft = Number.isFinite(metrics.actualBoundingBoxLeft) ? metrics.actualBoundingBoxLeft : 0;
  const inkRight = Number.isFinite(metrics.actualBoundingBoxRight) ? metrics.actualBoundingBoxRight : advance;
  // Some subset/fallback font stacks report only the first glyph's ink box.
  // Always enclose the advance as well, while retaining genuine ink overhangs.
  return { left: Math.min(0, -inkLeft), right: Math.max(advance, inkRight), advance };
}

function visibleMetrics(ctx: CanvasRenderingContext2D, text: string, tracking: number) {
  const declaredSize = Number(/([\d.]+)px/.exec(ctx.font)?.[1] || 16);
  if (tracking && text.length) {
    let cursor = 0; let minLeft = Number.POSITIVE_INFINITY; let maxRight = Number.NEGATIVE_INFINITY; let ascent = 0; let descent = 0;
    Array.from(text).forEach((glyph, index, glyphs) => {
      const glyphMetrics = ctx.measureText(glyph);
      const bounds = horizontalTextBounds(glyphMetrics);
      const glyphAscent = glyphMetrics.actualBoundingBoxAscent || declaredSize * .78;
      const glyphDescent = glyphMetrics.actualBoundingBoxDescent || declaredSize * .18;
      minLeft = Math.min(minLeft, cursor + bounds.left);
      maxRight = Math.max(maxRight, cursor + bounds.right);
      ascent = Math.max(ascent, glyphAscent); descent = Math.max(descent, glyphDescent);
      cursor += bounds.advance + (index < glyphs.length - 1 ? tracking : 0);
    });
    return { ascent, descent, left: -minLeft, width: maxRight - minLeft, height: ascent + descent };
  }
  const metrics = ctx.measureText(text);
  const bounds = horizontalTextBounds(metrics);
  const ascent = metrics.actualBoundingBoxAscent || declaredSize * .78;
  const descent = metrics.actualBoundingBoxDescent || declaredSize * .18;
  return { ascent, descent, left: -bounds.left, width: bounds.right - bounds.left, height: ascent + descent };
}

/**
 * Keeps text at a readable minimum size, then uses an ellipsis instead of
 * horizontally compressing a long value beyond its visual box.
 */
function drawVisualTextInBox(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
  role: ShareTextRole,
  align: 'left' | 'center' | 'right' = 'left',
  preserveSuffix = '',
) {
  const minimum = Math.min(role.size, MIN_SHARE_TEXT_SIZE);
  let fittedSize = role.size;
  let fittedMetrics: ReturnType<typeof visibleMetrics>;
  do {
    const candidate = { ...role, size: fittedSize };
    useTextRole(ctx, color, candidate);
    fittedMetrics = visibleMetrics(ctx, text, candidate.tracking);
    if ((fittedMetrics.width <= width && fittedMetrics.height <= height) || fittedSize <= minimum) break;
    fittedSize = Math.max(minimum, fittedSize - 2);
  } while (true);

  let fittedRole = { ...role, size: fittedSize };
  useTextRole(ctx, color, fittedRole);
  let clippedText = ellipsizeTracked(ctx, text, width, fittedRole.tracking, preserveSuffix);
  let metrics = visibleMetrics(ctx, clippedText, fittedRole.tracking);
  if (metrics.height > height) {
    // A box shorter than a 24px glyph cannot honor the shared minimum without overflow.
    // Reduce both axes through the font size only; never horizontally distort the glyphs.
    fittedRole = { ...fittedRole, size: Math.max(1, fittedRole.size * height / metrics.height) };
    useTextRole(ctx, color, fittedRole);
    clippedText = ellipsizeTracked(ctx, text, width, fittedRole.tracking, preserveSuffix);
    metrics = visibleMetrics(ctx, clippedText, fittedRole.tracking);
  }
  const left = align === 'center' ? (width - metrics.width) / 2 : align === 'right' ? width - metrics.width : 0;
  const top = Math.max(0, (height - metrics.height) / 2);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  drawTrackedAtBaseline(ctx, clippedText, x + left + metrics.left, y + top + metrics.ascent, fittedRole.tracking);
  ctx.restore();
}

function ellipsizeTracked(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, tracking = 0, preserveSuffix = '') {
  if (trackedWidth(ctx, text, tracking) <= maxWidth) return text;
  const suffix = preserveSuffix && text.endsWith(preserveSuffix) ? preserveSuffix : '';
  // Preserve the token-share fact while shortening only a pathological name.
  if (suffix && trackedWidth(ctx, `…${suffix}`, tracking) > maxWidth) {
    return ellipsizeTracked(ctx, suffix, maxWidth, tracking);
  }
  const glyphs = Array.from(suffix ? text.slice(0, -suffix.length) : text);
  while (glyphs.length > 0 && trackedWidth(ctx, `${glyphs.join('')}…${suffix}`, tracking) > maxWidth) glyphs.pop();
  return `${glyphs.join('')}…${suffix}`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number, fill?: string, stroke?: string, lineWidth = 1) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, Math.min(radius, width / 2, height / 2));
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.lineWidth = lineWidth; ctx.strokeStyle = stroke; ctx.stroke(); }
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string, width = 1, dash: number[] = []) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

function formattedDelta(summary: ShareSummary) {
  if (summary.deltaDirection === 'new') return '本期新增记录';
  if (summary.deltaPercent === null || summary.deltaDirection === null) return null;
  const marker = summary.deltaDirection === 'up' ? '+' : summary.deltaDirection === 'down' ? '−' : '';
  return `${marker}${summary.deltaPercent}%`;
}

/** 与界面 SVG、安装图标共用同一份源路径；颜色由海报自身的前景色决定。 */
function drawVectorBrandEmblem(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / TOKEN_LEDGER_SIZE, size / TOKEN_LEDGER_SIZE);
  ctx.strokeStyle = color;
  ctx.lineWidth = TOKEN_LEDGER_STROKE_WIDTH;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(new Path2D(TOKEN_LEDGER_PATH));
  ctx.restore();
}

function drawFooter(ctx: CanvasRenderingContext2D, summary: ShareSummary, p: Palette, layout: ShareLayoutKey, appVersion?: string) {
  const anchor = SHARE_FOOTER_ANCHORS[layout];
  const role = SHARE_TYPOGRAPHY[layout].footer;
  const [brandX, brandY, , brandHeight] = anchor.brand;
  line(ctx, 72, anchor.dividerY, 1008, anchor.dividerY, p.line, 2);
  const iconSize = Math.min(52, Math.round(role.size * 1.15));
  const iconY = brandY + (brandHeight - iconSize) / 2;

  drawVectorBrandEmblem(ctx, anchor.iconX, iconY, iconSize, p.fg);
  setText(ctx, p.fg, Math.round(role.size * 0.92), 800, FONT_SANS);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('TokenLedger', brandX, brandY + brandHeight / 2);

  const primaryMeta = `${summary.sourceLabel} · ${summary.generatedLabel}${summary.isStale ? ' · 缓存快照' : ''}`;
  const boundaryMeta = summary.boundaryNotes.filter((note) => note !== '数据为缓存快照').join(' · ');
  const secondaryMeta = `${boundaryMeta}${boundaryMeta && appVersion ? ' · ' : ''}${appVersion ? `v${appVersion}` : ''}`;
  if (anchor.centered) {
    drawVisualTextInBox(ctx, primaryMeta, 130, 1868, 820, 22, p.muted, textRole(FONT_SANS, 20, 500), 'center');
    if (secondaryMeta) drawVisualTextInBox(ctx, secondaryMeta, 130, 1894, 820, 22, p.muted, textRole(FONT_SANS, 20, 500), 'center');
  } else {
    drawVisualTextInBox(ctx, primaryMeta, 520, 1814, 488, 24, p.muted, textRole(FONT_SANS, 20, 500), 'left');
    if (secondaryMeta) drawVisualTextInBox(ctx, secondaryMeta, 520, 1844, 488, 24, p.muted, textRole(FONT_SANS, 20, 500), 'left');
  }
}

// -------------------------------------------------------------
// Layout 1: Scorecard (数据海报) - 科技精工暗黑看板
// -------------------------------------------------------------
/**
 * Only the editorial poster shows proven positive net savings with listed prices.
 * The summarized figures have already removed hidden, unavailable and fallback-priced amounts.
 */
export function shareCardCostFacts(layout: ShareLayoutKey, summary: Pick<ShareSummary, 'cacheNetSavedUsd'>): string[] {
  return layout === 'scorecard' && summary.cacheNetSavedUsd !== null && Number.isFinite(summary.cacheNetSavedUsd) && summary.cacheNetSavedUsd > 0 ? ['缓存净节省'] : [];
}

function rangeHeadline(range: RangeKey) {
  if (range === 'today') return '今天';
  if (range === 'week') return '这周';
  if (range === 'month') return '这个月';
  if (range === 'year') return '今年';
  if (range === 'all') return '一路以来';
  return '这段时间';
}

function rangeArchiveTitle(range: RangeKey) {
  if (range === 'today') return '今日存档';
  if (range === 'week') return '本周存档';
  if (range === 'month') return '本月存档';
  if (range === 'year') return '年度存档';
  if (range === 'all') return '协作总存档';
  return '区间存档';
}

function monthNameFromPeriodLabel(label: string) {
  const match = /(?:^|—)(?:\d{4}年)?(\d{1,2})月/.exec(label);
  const month = match ? Number(match[1]) : 0;
  const names = ['', '一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
  return names[month] || null;
}

function rangeEnglishKicker(range: RangeKey) {
  if (range === 'today') return 'DAILY MIX';
  if (range === 'week') return 'WEEKLY MIX';
  if (range === 'month') return 'MONTHLY MIX';
  if (range === 'year') return 'YEARLY MIX';
  if (range === 'all') return 'COLLABORATION ARCHIVE';
  return 'PERIOD MIX';
}

function compactIdentity(value: string | undefined, fallback: string) {
  // Bound pathological input only; the actual text box chooses font size and ellipsis.
  const maxGlyphs = 128;
  const normalized = value?.trim() || fallback;
  const glyphs = Array.from(normalized);
  return glyphs.length > maxGlyphs ? `${glyphs.slice(0, Math.max(1, maxGlyphs - 1)).join('')}…` : normalized;
}

function drawPosterGrain(ctx: CanvasRenderingContext2D, color: string, opacity = .08) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = opacity;
  for (let index = 0; index < 420; index += 1) {
    const x = (index * 97 + (index % 17) * 43) % SHARE_CARD_WIDTH;
    const y = (index * 173 + (index % 29) * 31) % SHARE_CARD_HEIGHT;
    const size = index % 9 === 0 ? 3 : 1;
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
}

function drawCornerRegistration(ctx: CanvasRenderingContext2D, color: string) {
  line(ctx, 42, 42, 102, 42, color, 3);
  line(ctx, 42, 42, 42, 102, color, 3);
  line(ctx, 978, 42, 1038, 42, color, 3);
  line(ctx, 1038, 42, 1038, 102, color, 3);
}

function drawScorecard(ctx: CanvasRenderingContext2D, s: ShareSummary, version?: string) {
  const p: Palette = {
    bg: '#f3f0e6', fg: '#070707', muted: '#3e3d37', faint: '#706d63',
    accent: '#ff1f1f', secondary: '#d9f600', line: '#111111',
  };
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);
  drawPosterGrain(ctx, '#111111', .055);

  // Oversized red editorial strokes create the reference's type-riot energy.
  ctx.save();
  ctx.translate(772, 40);
  ctx.rotate(-.12);
  setText(ctx, p.accent, 840, 900, FONT_NUMBER);
  ctx.globalAlpha = .94;
  ctx.fillText('A', 0, 0);
  ctx.restore();
  ctx.save();
  ctx.translate(920, 748);
  ctx.rotate(.2);
  ctx.fillStyle = p.accent;
  ctx.globalAlpha = .96;
  ctx.fillRect(0, 0, 240, 1120);
  ctx.restore();
  drawCornerRegistration(ctx, p.accent);

  setText(ctx, p.fg, 54, 900, FONT_SANS);
  ctx.fillText('TokenLedger', 58, 58);
  drawVisualTextInBox(ctx, s.periodLabel, 58, 132, 420, 50, p.fg, textRole(FONT_NUMBER, 40, 500, 1), 'left');
  roundRect(ctx, 58, 192, 190, 44, 0, p.secondary);
  drawVisualTextInBox(ctx, s.range === 'all' ? '协作里程碑' : '周期记录', 68, 197, 170, 32, p.fg, textRole(FONT_SANS, 28, 900), 'center');

  const headline = rangeHeadline(s.range);
  drawVisualTextInBox(ctx, headline, 52, 280, 520, 168, p.fg, textRole(FONT_SANS, 188, 900, -5), 'left');
  drawVisualTextInBox(ctx, '和 AI 一起', 52, 438, 680, 170, p.fg, textRole(FONT_SANS, 174, 900, -5), 'left');
  line(ctx, 50, 630, 740, 584, p.accent, 15);

  drawVisualTextInBox(ctx, formatTokens(s.effectiveTokens), 48, 684, 870, 330, p.fg, textRole(FONT_NUMBER, 360, 900, -12), 'left');
  drawVisualTextInBox(ctx, '有效 Token', 56, 1000, 580, 82, p.fg, textRole(FONT_SANS, 68, 900), 'left');

  ctx.fillStyle = p.bg;
  ctx.fillRect(36, 1094, 996, 658);
  drawPosterGrain(ctx, '#111111', .025);
  line(ctx, 54, 1118, 1018, 1118, p.line, 2);
  const active = s.activeDays !== null ? String(s.activeDays) : '—';
  const secondaryFacts = [
    [formatNum(s.totalRequests), '记录数'],
    [active, s.activeDays !== null ? '活跃天' : '活跃天数未提供'],
  ];
  secondaryFacts.forEach(([value, label], index) => {
    const x = 56 + index * 520;
    if (index) line(ctx, x - 34, 1154, x - 34, 1330, p.line, 2);
    drawVisualTextInBox(ctx, value, x, 1140, 440, 126, p.fg, textRole(FONT_NUMBER, 138, 900, -4), 'left');
    drawVisualTextInBox(ctx, label, x, 1270, 440, 46, p.fg, textRole(FONT_SANS, 36, 800), 'left');
  });

  line(ctx, 54, 1360, 1018, 1360, p.line, 2);
  drawVisualTextInBox(ctx, '协作构成', 56, 1392, 360, 52, p.fg, textRole(FONT_SANS, 44, 900), 'left');
  const composition = [
    ['输入', formatTokens(s.inputTokens), p.fg],
    ['输出', formatTokens(s.outputTokens), p.accent],
    ['缓存', formatTokens(s.cachedTokens), p.fg],
  ] as const;
  composition.forEach(([label, value, color], index) => {
    const x = 56 + index * 322;
    if (index) line(ctx, x - 22, 1480, x - 22, 1632, p.line, 2);
    drawVisualTextInBox(ctx, label, x, 1472, 278, 38, p.fg, textRole(FONT_SANS, 28, 700), 'left');
    drawVisualTextInBox(ctx, value, x, 1518, 278, 84, color, textRole(FONT_NUMBER, 74, 900, -2), 'left');
  });
  const leaderShare = s.topTool?.sharePercent !== null && s.topTool?.sharePercent !== undefined ? ` · 占 ${s.topTool.sharePercent}%` : '';
  drawVisualTextInBox(ctx, `工具 ${compactIdentity(s.topTool?.name, '未提供')}${leaderShare}`, 56, 1628, 900, 38, p.fg, textRole(FONT_SANS, 26, 800), 'left', leaderShare);
  drawVisualTextInBox(ctx, `模型 ${compactIdentity(s.topModel?.name, '未提供')}`, 56, 1670, 900, 38, p.fg, textRole(FONT_SANS, 26, 800), 'left');
  if (shareCardCostFacts('scorecard', s).length > 0) {
    drawVisualTextInBox(ctx, '缓存净节省', 56, 1712, 230, 34, p.fg, textRole(FONT_SANS, 26, 800), 'left');
    drawVisualTextInBox(ctx, formatEstimatedUsd(s.cacheNetSavedUsd), 274, 1710, 240, 36, p.accent, textRole(FONT_NUMBER, 32, 900), 'left');
  }
  ctx.fillStyle = p.bg;
  ctx.fillRect(36, 1768, 996, 152);
  drawFooter(ctx, s, p, 'scorecard', version);
}

function drawJournal(ctx: CanvasRenderingContext2D, s: ShareSummary, version?: string) {
  const p: Palette = {
    bg: '#f7f4ea', fg: '#050505', muted: '#383838', faint: '#696969',
    accent: '#064cff', secondary: '#97ff16', line: 'rgba(0,0,0,.22)',
  };
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);
  drawPosterGrain(ctx, '#0b0b0b', .035);

  // Geometric playset: blue orbit, lime staircase, pink soft tile and green burst.
  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.arc(905, 28, 318, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.bg;
  ctx.beginPath();
  ctx.arc(1028, 80, 92, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.secondary;
  for (let index = 0; index < 5; index += 1) {
    roundRect(ctx, 640 + index * 82, 470 - index * 102, 278, 760 + index * 10, 38, p.secondary);
  }
  roundRect(ctx, 270, 965, 810, 525, 92, '#f29ddd');
  ctx.save();
  ctx.translate(40, 1120);
  ctx.fillStyle = p.secondary;
  for (let spoke = 0; spoke < 12; spoke += 1) {
    ctx.save();
    ctx.rotate(spoke * Math.PI / 6);
    ctx.fillRect(0, -18, 190, 36);
    ctx.restore();
  }
  ctx.restore();

  setText(ctx, p.fg, 54, 900);
  ctx.fillText('TokenLedger', 54, 52);
  drawVisualTextInBox(ctx, s.periodLabel, 54, 128, 440, 46, p.fg, textRole(FONT_NUMBER, 38, 800, 1), 'left');
  drawVisualTextInBox(ctx, '我的 AI 搭子', 48, 218, 790, 118, p.fg, textRole(FONT_SANS, 122, 900, -4), 'left');
  drawVisualTextInBox(ctx, rangeEnglishKicker(s.range), 52, 350, 640, 64, p.fg, textRole(FONT_NUMBER, 58, 900, 10), 'left');

  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.arc(292, 700, 292, 0, Math.PI * 2);
  ctx.fill();
  const toolShare = s.topTool?.sharePercent;
  drawVisualTextInBox(ctx, compactIdentity(s.topTool?.name, '主力工具未提供'), 48, 560, 470, 74, '#ffffff', textRole(FONT_SANS, 38, 900), 'center');
  drawVisualTextInBox(ctx, toolShare !== null && toolShare !== undefined ? `${toolShare}%` : formatTokens(s.inputTokens), 36, 660, 510, 180, '#ffffff', textRole(FONT_NUMBER, 202, 900, -6), 'center');

  drawVisualTextInBox(ctx, '记录', 688, 620, 330, 58, p.fg, textRole(FONT_SANS, 46, 900), 'center');
  drawVisualTextInBox(ctx, formatNum(s.totalRequests), 660, 690, 380, 152, p.fg, textRole(FONT_NUMBER, 176, 900, -5), 'center');

  const modelShare = s.topModel?.sharePercent;
  drawVisualTextInBox(ctx, compactIdentity(s.topModel?.name, '主力模型未提供'), 350, 1050, 610, 70, p.fg, textRole(FONT_SANS, 38, 900), 'left');
  drawVisualTextInBox(ctx, modelShare !== null && modelShare !== undefined ? `${modelShare}%` : formatTokens(s.outputTokens), 368, 1138, 570, 180, p.fg, textRole(FONT_NUMBER, 190, 900, -5), 'center');

  drawVisualTextInBox(ctx, formatTokens(s.effectiveTokens), 42, 1480, 760, 210, p.accent, textRole(FONT_NUMBER, 240, 900, -8), 'left');
  drawVisualTextInBox(ctx, '有效 Token', 48, 1680, 390, 52, p.fg, textRole(FONT_SANS, 48, 900), 'left');
  drawVisualTextInBox(ctx, s.activeDays !== null ? `${s.activeDays} 活跃天` : '活跃天不可得', 650, 1682, 360, 50, p.fg, textRole(FONT_SANS, 38, 800), 'right');
  drawFooter(ctx, s, p, 'journal', version);
}

function drawAchievement(ctx: CanvasRenderingContext2D, s: ShareSummary, version?: string) {
  const p: Palette = {
    bg: '#021a2b', fg: '#e9f6ff', muted: '#b7cee0', faint: '#7ea4bf',
    accent: '#d9efff', secondary: '#ffb26f', line: 'rgba(215,238,255,.42)',
  };
  if (liquidArchiveBackground?.complete) {
    ctx.drawImage(liquidArchiveBackground, 0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);
  } else {
    const bg = ctx.createLinearGradient(0, 0, 0, SHARE_CARD_HEIGHT);
    bg.addColorStop(0, '#02192a');
    bg.addColorStop(1, '#00111f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);
    // Deterministic metallic loop fallback; the production export preloads the art plate.
    ctx.save();
    ctx.translate(540, 920);
    ctx.strokeStyle = '#a8d4f4';
    ctx.lineWidth = 96;
    ctx.globalAlpha = .72;
    ctx.beginPath();
    ctx.arc(-180, 0, 250, -.8, 4.4);
    ctx.arc(180, 0, 250, 2.35, 7.55);
    ctx.stroke();
    ctx.restore();
  }
  const shade = ctx.createLinearGradient(0, 0, 0, SHARE_CARD_HEIGHT);
  shade.addColorStop(0, 'rgba(0,18,32,.2)');
  shade.addColorStop(.48, 'rgba(0,12,24,0)');
  shade.addColorStop(1, 'rgba(0,15,28,.58)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);

  setText(ctx, p.fg, 52, 800);
  ctx.fillText('TokenLedger', 48, 54);
  drawVisualTextInBox(ctx, s.periodLabel, 610, 54, 422, 46, p.fg, textRole(FONT_SANS, 32, 700), 'right');
  drawVisualTextInBox(ctx, `我与 AI 的${s.range === 'month' ? (monthNameFromPeriodLabel(s.periodLabel) || '本月') : rangeHeadline(s.range)}`, 170, 148, 740, 76, p.fg, textRole(FONT_SANS, 72, 700, 3), 'center');
  drawVisualTextInBox(ctx, 'COLLABORATION ARCHIVE', 210, 238, 660, 44, p.muted, textRole(FONT_NUMBER, 30, 500, 10), 'center');

  const dayValue = s.activeDays !== null ? String(s.activeDays) : '—';
  drawVisualTextInBox(ctx, dayValue, 278, 300, 524, 238, p.accent, textRole(FONT_NUMBER, 270, 700, -8), 'center');
  drawVisualTextInBox(ctx, s.activeDays !== null ? '活跃天' : '活跃天数未提供', 360, 548, 360, 62, p.fg, textRole(FONT_SANS, 48, 700, 4), 'center');

  // Keep the photographic object unobstructed. Facts sit in the dark reflection area.
  drawVisualTextInBox(ctx, formatTokens(s.effectiveTokens), 68, 1408, 430, 142, p.fg, textRole(FONT_NUMBER, 142, 700, -5), 'center');
  drawVisualTextInBox(ctx, '有效 Token', 108, 1550, 350, 48, p.muted, textRole(FONT_SANS, 38, 600, 2), 'center');
  line(ctx, 540, 1418, 540, 1608, p.line, 2);
  drawVisualTextInBox(ctx, formatNum(s.totalRequests), 592, 1408, 420, 142, p.fg, textRole(FONT_NUMBER, 142, 700, -5), 'center');
  drawVisualTextInBox(ctx, '记录数', 630, 1550, 344, 48, p.muted, textRole(FONT_SANS, 38, 600, 2), 'center');
  const toolShare = s.topTool?.sharePercent !== null && s.topTool?.sharePercent !== undefined ? ` ${s.topTool.sharePercent}%` : '';
  const modelShare = s.topModel?.sharePercent !== null && s.topModel?.sharePercent !== undefined ? ` ${s.topModel.sharePercent}%` : '';
  drawVisualTextInBox(ctx, `${compactIdentity(s.topTool?.name, '工具未提供')}${toolShare}`, 84, 1646, 430, 52, p.fg, textRole(FONT_SANS, 26, 600), 'center', toolShare);
  drawVisualTextInBox(ctx, `${compactIdentity(s.topModel?.name, '模型未提供')}${modelShare}`, 566, 1646, 430, 52, p.fg, textRole(FONT_SANS, 26, 600), 'center', modelShare);
  drawFooter(ctx, s, p, 'achievement', version);
}

function drawReceipt(ctx: CanvasRenderingContext2D, s: ShareSummary, version?: string) {
  const p: Palette = {
    bg: '#ff3f9c', fg: '#2b0646', muted: '#5a235e', faint: '#7e4676',
    accent: '#ff3f9c', secondary: '#ffe2d7', line: '#2b0646',
  };
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);
  drawPosterGrain(ctx, '#2b0646', .08);
  line(ctx, 78, 48, 1002, 48, p.line, 5);
  line(ctx, 100, 180, 980, 180, p.line, 5);

  // Ticket side waves and punch holes.
  for (const side of [0, 1]) {
    const edge = side ? 1080 : 0;
    ctx.fillStyle = p.fg;
    ctx.beginPath();
    ctx.arc(edge, 160, 46, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(edge, 1460, 46, 0, Math.PI * 2);
    ctx.fill();
    for (let index = 0; index < 15; index += 1) {
      const x = side ? 1068 - index * 5 : 12 + index * 5;
      line(ctx, x, 230, side ? 1008 - index * 10 : 72 + index * 10, 1160, 'rgba(43,6,70,.55)', 2);
    }
  }

  setText(ctx, p.fg, 54, 900);
  ctx.fillText('TokenLedger', 116, 78);
  drawVisualTextInBox(ctx, s.periodLabel, 520, 78, 430, 54, p.fg, textRole(FONT_SANS, 30, 800), 'right');
  drawVisualTextInBox(ctx, s.range === 'month' ? `${monthNameFromPeriodLabel(s.periodLabel) || '月度'}通行证` : `${rangeHeadline(s.range)}通行证`, 90, 225, 900, 132, p.fg, textRole(FONT_SANS, 138, 900, -5), 'center');
  drawVisualTextInBox(ctx, s.range === 'all' ? 'ARCHIVE PASS' : `${rangeEnglishKicker(s.range).replace(' MIX', '')} PASS`, 250, 372, 580, 58, p.fg, textRole(FONT_NUMBER, 54, 900, 12), 'center');
  line(ctx, 106, 458, 974, 458, p.line, 5);

  drawVisualTextInBox(ctx, formatNum(s.totalRequests), 120, 500, 840, 340, p.fg, textRole(FONT_NUMBER, 390, 900, -12), 'center');
  drawVisualTextInBox(ctx, '记录数', 260, 842, 560, 122, p.fg, textRole(FONT_SANS, 118, 900), 'center');
  line(ctx, 106, 1000, 974, 1000, p.line, 4);

  drawVisualTextInBox(ctx, formatTokens(s.effectiveTokens), 108, 1038, 520, 170, p.fg, textRole(FONT_NUMBER, 176, 900, -5), 'left');
  drawVisualTextInBox(ctx, '有效 Token', 114, 1202, 460, 58, p.fg, textRole(FONT_SANS, 46, 900), 'left');
  line(ctx, 650, 1034, 650, 1264, p.line, 3);
  drawVisualTextInBox(ctx, s.activeDays !== null ? String(s.activeDays) : '—', 702, 1038, 270, 170, p.fg, textRole(FONT_NUMBER, 176, 900, -5), 'center');
  drawVisualTextInBox(ctx, s.activeDays !== null ? '活跃天' : '活跃天数未提供', 714, 1202, 250, 58, p.fg, textRole(FONT_SANS, 46, 900), 'center');

  // Cream tear-off stub.
  ctx.fillStyle = p.secondary;
  ctx.fillRect(0, 1382, SHARE_CARD_WIDTH, 538);
  for (let x = 36; x < SHARE_CARD_WIDTH; x += 36) {
    ctx.fillStyle = p.fg;
    ctx.beginPath();
    ctx.arc(x, 1382, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  drawVisualTextInBox(ctx, '我的协作组合', 106, 1434, 430, 58, p.fg, textRole(FONT_SANS, 44, 900), 'left');
  const rows = [
    ['主力工具', compactIdentity(s.topTool?.name, '未提供')],
    ['主力模型', compactIdentity(s.topModel?.name, '未提供')],
    ['同期变化', formattedDelta(s) || '无可靠基线'],
  ];
  rows.forEach(([label, value], index) => {
    const y = 1518 + index * 86;
    line(ctx, 106, y + 68, 974, y + 68, 'rgba(43,6,70,.38)', 2);
    drawVisualTextInBox(ctx, label, 106, y, 280, 54, p.fg, textRole(FONT_SANS, 36, 800), 'left');
    drawVisualTextInBox(ctx, value, 520, y, 454, 54, p.fg, textRole(FONT_SANS, 34, 900), 'left');
  });
  drawFooter(ctx, s, p, 'receipt', version);
}

function drawPixelLandscape(ctx: CanvasRenderingContext2D) {
  const pixel = 18;
  const islands = [
    { x: 0, y: 1040, w: 18, h: 8 }, { x: 170, y: 990, w: 18, h: 9 },
    { x: 390, y: 930, w: 20, h: 11 }, { x: 650, y: 850, w: 24, h: 12 },
    { x: 900, y: 900, w: 14, h: 10 },
  ];
  islands.forEach((island, islandIndex) => {
    for (let row = 0; row < island.h; row += 1) {
      const inset = Math.min(row, 3);
      for (let col = inset; col < island.w - inset; col += 1) {
        const x = island.x + col * pixel;
        const y = island.y + row * pixel;
        ctx.fillStyle = row < 3 ? ((col + islandIndex) % 5 === 0 ? '#9ed65f' : '#70b357') : row < 6 ? '#477c4e' : '#315f47';
        ctx.fillRect(x, y, pixel + 1, pixel + 1);
      }
    }
  });
  // Water bed, bridge, shrine and small trees.
  ctx.fillStyle = '#377a66';
  for (let row = 0; row < 14; row += 1) {
    for (let col = 0; col < 42; col += 1) {
      if ((row + col) % 5 !== 0) ctx.fillRect(180 + col * pixel, 1120 + row * pixel, pixel + 1, pixel + 1);
    }
  }
  for (let index = 0; index < 29; index += 1) {
    ctx.fillStyle = index % 2 ? '#dedfc5' : '#f1eed4';
    ctx.fillRect(250 + index * 20, 1200 - index * 9, 28, 28);
  }
  ctx.fillStyle = '#eff0d5';
  ctx.fillRect(774, 936, 180, 152);
  ctx.fillStyle = '#c9d0ad';
  ctx.fillRect(792, 954, 144, 116);
  ctx.fillStyle = '#0b3427';
  ctx.fillRect(834, 990, 62, 80);
  ctx.fillStyle = '#ffd348';
  ctx.fillRect(852, 1008, 26, 26);
  for (const [x, y] of [[92,1030],[212,960],[580,1010],[690,820],[976,860],[530,1170],[930,1130]]) {
    ctx.fillStyle = '#205c43';
    ctx.fillRect(x + 18, y + 44, 18, 54);
    ctx.fillStyle = '#2f7950';
    ctx.fillRect(x, y + 18, 54, 54);
    ctx.fillStyle = '#3e8d56';
    ctx.fillRect(x + 18, y, 54, 54);
  }
}

function drawSignal(ctx: CanvasRenderingContext2D, s: ShareSummary, version?: string) {
  const p: Palette = {
    bg: '#e6efd5', fg: '#0b3427', muted: '#365e4d', faint: '#76947a',
    accent: '#ffd348', secondary: '#70b357', line: '#8eaa83',
  };
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);
  const glow = ctx.createRadialGradient(540, 520, 40, 540, 720, 900);
  glow.addColorStop(0, 'rgba(255,255,238,.9)');
  glow.addColorStop(1, 'rgba(191,214,164,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);

  setText(ctx, p.fg, 52, 900, FONT_RECEIPT_PIXEL);
  ctx.fillText('TokenLedger', 68, 50);
  // Keep both ends readable in the narrow pixel heading; the semantic summary stays complete.
  const compactPeriod = s.periodLabel.replace(/(\d{4})年(\d{1,2})月(\d{1,2})日/g, '$1.$2.$3');
  drawVisualTextInBox(ctx, compactPeriod, 650, 50, 360, 46, p.fg, textRole(FONT_RECEIPT_PIXEL, 36, 400, 2), 'right');
  ctx.fillStyle = p.accent;
  ctx.fillRect(1018, 63, 18, 18);
  drawVisualTextInBox(ctx, s.range === 'month' ? `${monthNameFromPeriodLabel(s.periodLabel) || '本月'}存档` : rangeArchiveTitle(s.range), 66, 140, 790, 118, p.fg, textRole(FONT_SANS, 124, 900, -4), 'left');
  // Pixel document icon.
  ctx.fillStyle = p.accent;
  ctx.fillRect(868, 150, 74, 94);
  ctx.fillStyle = p.fg;
  ctx.fillRect(856, 138, 86, 12);
  ctx.fillRect(856, 138, 12, 118);
  ctx.fillRect(856, 244, 98, 12);
  ctx.fillRect(942, 162, 12, 94);
  ctx.fillRect(918, 150, 12, 24);
  ctx.fillRect(930, 162, 24, 12);
  drawVisualTextInBox(ctx, `${rangeEnglishKicker(s.range)} SAVE`, 68, 270, 760, 60, p.fg, textRole(FONT_RECEIPT_PIXEL, 50, 400, 9), 'left');

  drawVisualTextInBox(ctx, formatTokens(s.effectiveTokens), 54, 368, 974, 250, p.fg, textRole(FONT_RECEIPT_PIXEL, 284, 400, -3), 'left');
  drawVisualTextInBox(ctx, '有效 Token', 66, 620, 520, 64, p.fg, textRole(FONT_SANS, 58, 900), 'left');
  drawVisualTextInBox(ctx, formatNum(s.totalRequests), 66, 724, 360, 142, p.fg, textRole(FONT_RECEIPT_PIXEL, 166, 400, -2), 'left');
  drawVisualTextInBox(ctx, '记录数', 72, 860, 300, 52, p.fg, textRole(FONT_SANS, 42, 800), 'left');
  line(ctx, 450, 736, 450, 902, p.line, 3);
  drawVisualTextInBox(ctx, s.activeDays !== null ? String(s.activeDays) : '—', 510, 724, 300, 142, p.fg, textRole(FONT_RECEIPT_PIXEL, 166, 400, -2), 'left');
  drawVisualTextInBox(ctx, s.activeDays !== null ? '活跃天' : '天数未知', 516, 860, s.activeDays !== null ? 420 : 128, 52, p.fg, textRole(FONT_SANS, 42, 800), 'left');

  drawPixelLandscape(ctx);

  ctx.fillStyle = 'rgba(230,239,213,.96)';
  ctx.fillRect(0, 1440, SHARE_CARD_WIDTH, 480);
  const rows = [
    ['主力工具', compactIdentity(s.topTool?.name, '未提供')],
    ['主力模型', compactIdentity(s.topModel?.name, '未提供')],
    ['输入 / 输出 / 缓存', `${formatTokens(s.inputTokens)} / ${formatTokens(s.outputTokens)} / ${formatTokens(s.cachedTokens)}`],
  ];
  rows.forEach(([label, value], index) => {
    const y = 1484 + index * 92;
    line(ctx, 64, y + 70, 1016, y + 70, p.line, 2);
    drawVisualTextInBox(ctx, label, 64, y, 350, 58, p.fg, textRole(FONT_SANS, 38, 800), 'left');
    drawVisualTextInBox(ctx, value, 420, y, 596, 58, p.fg, textRole(FONT_RECEIPT_PIXEL, 44, 400, 1), 'right');
  });
  drawFooter(ctx, s, p, 'signal', version);
}

// -------------------------------------------------------------
// Canvas export & lifecycle hooks
// -------------------------------------------------------------
export function renderShareCardToCanvas(options: ShareCardOptions): HTMLCanvasElement {
  const scene = buildShareCardScene(options);
  const canvas = document.createElement('canvas');
  canvas.width = SHARE_CARD_WIDTH;
  canvas.height = SHARE_CARD_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建海报画布，请重试');

  if (scene.layout === 'journal') drawJournal(ctx, scene.summary, options.appVersion);
  else if (scene.layout === 'achievement') drawAchievement(ctx, scene.summary, options.appVersion);
  else if (scene.layout === 'receipt') drawReceipt(ctx, scene.summary, options.appVersion);
  else if (scene.layout === 'signal') drawSignal(ctx, scene.summary, options.appVersion);
  else drawScorecard(ctx, scene.summary, options.appVersion);

  return canvas;
}

export async function exportShareCardBlob(options: ShareCardOptions): Promise<Blob> {
  await ensureShareCardAssetsReady(options.layout || 'scorecard');
  const canvas = renderShareCardToCanvas(options);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Failed to create PNG blob from canvas')), 'image/png'));
}

export async function copyShareCardToClipboard(options: ShareCardOptions): Promise<boolean> {
  try {
    const blob = await exportShareCardBlob(options);
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Failed to copy share card to clipboard:', error);
    return false;
  }
}

export async function downloadShareCardImage(options: ShareCardOptions, filename?: string): Promise<void> {
  const blob = await exportShareCardBlob(options);
  const url = URL.createObjectURL(blob);
  const now = options.now || new Date();
  const tag = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || `TokenLedger_周期总结_${options.range}_${options.layout || 'scorecard'}_${tag}.png`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
