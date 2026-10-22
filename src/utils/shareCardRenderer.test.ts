import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TOKEN_LEDGER_PATH, TOKEN_LEDGER_STROKE_WIDTH } from '../components/brand/tokenLedgerGeometry';
import type { StatsData } from '../types';
import {
  SHARE_BACKGROUND_ASSETS,
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  SHARE_FONT_FAMILIES,
  SHARE_FONT_LOAD_SPECS,
  SHARE_FOOTER_ANCHORS,
  SHARE_HERO_RENDERING,
  SHARE_LAYOUTS,
  SHARE_TEXT_BOXES,
  SHARE_TYPOGRAPHY,
  buildShareCardScene,
  ensureShareCardAssetsReady,
  exportShareCardBlob,
  renderShareCardToCanvas,
  shareCardCostFacts,
} from './shareCardRenderer';
import type { ShareLayoutKey } from './shareSummary';

const MOCK_STATS: StatsData = {
  summary: {
    totalTokens: 2_450_000,
    inputTokens: 2_000_000,
    outputTokens: 450_000,
    cachedTokens: 1_200_000,
    cacheReadTokens: 1_150_000,
    cacheWriteTokens: 50_000,
    totalCost: 128.45,
    cacheSavedUsd: 45.2,
    cacheSavings: { readSavedUsd: 45.2, writePremiumUsd: 5.2, netSavedUsd: 40, fallbackPricedReadTokens: 0, fallbackPricedWriteTokens: 0, priceBasis: 'local-prices' },
    totalRequests: 3420,
    avgTokensPerReq: 716,
  },
  tools: {
    codex: { name: 'Codex CLI', input: 1_200_000, output: 220_000, cached: 0, cost: 70, total: 1_420_000, requests: 1800 },
  },
  models: {
    gpt: { name: 'GPT-5', total: 1_200_000, input: 1_000_000, output: 200_000, cached: 800_000, cost: 82.4, requests: 1500 },
  },
  trends: [],
  heatmap: { '2026-08-15': 1_000_000, '2026-08-16': 1_450_000 },
  history: [],
  meta: { generatedAt: '2026-08-16T18:00:00+08:00', timezone: 'Asia/Shanghai' },
};

const LAYOUT_KEYS = Object.keys(SHARE_LAYOUTS) as ShareLayoutKey[];


class RecordedPath2D {
  source: string;
  constructor(source: string) { this.source = source; }
}

beforeAll(() => vi.stubGlobal('Path2D', RecordedPath2D));
afterAll(() => vi.unstubAllGlobals());

const SHARE_LEADER_FIXTURE_STATS: StatsData = {
  ...MOCK_STATS,
  summary: { ...MOCK_STATS.summary, totalTokens: 994_500, inputTokens: 700_000, outputTokens: 294_500 },
  tools: {
    codex: { name: 'Codex CLI', input: 300_000, output: 57_800, cached: 0, total: 357_800, cost: 5, requests: 30 },
  },
  models: {
    'gpt-5-codex': { name: 'GPT-5 Codex', input: 250_000, output: 50_000, total: 300_000, cost: 4, requests: 25 },
  },
};

function createRecordingCanvasContext() {
  const draws: Array<{ text: string; x: number; y: number; font: string; color: string; scale: number[] }> = [];
  const brandStrokes: Array<{ source: string; color: string; width: number; cap: string; join: string; scale: number[] }> = [];
  let lastScale = [1, 1];
  const savedScales: number[][] = [];
  const gradient = { addColorStop: vi.fn() };
  const context = {
    fillText: vi.fn((text: string, x: number, y: number) => draws.push({ text, x, y, font: context.font, color: context.fillStyle, scale: [...lastScale] })),
    measureText: vi.fn((text: string) => {
      const size = Number(/([\d.]+)px/.exec(context.font)?.[1] || 16);
      const width = Array.from(text).length * size * 0.62;
      return {
        width,
        actualBoundingBoxAscent: size * 0.78,
        actualBoundingBoxDescent: size * 0.18,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
      };
    }),
    font: '500 16px sans-serif',
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', textBaseline: 'alphabetic', textAlign: 'left', globalAlpha: 1,
    beginPath: vi.fn(), closePath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), arc: vi.fn(), rect: vi.fn(), clip: vi.fn(), fill: vi.fn(),
    stroke: vi.fn((path?: RecordedPath2D) => {
      if (path instanceof RecordedPath2D) brandStrokes.push({
        source: path.source, color: context.strokeStyle, width: context.lineWidth, cap: context.lineCap, join: context.lineJoin, scale: [...lastScale],
      });
    }),
    fillRect: vi.fn(), strokeRect: vi.fn(),
    roundRect: vi.fn(), setLineDash: vi.fn(),
    save: vi.fn(() => { savedScales.push([...lastScale]); }),
    restore: vi.fn(() => { lastScale = savedScales.pop() ?? [1, 1]; }),
    translate: vi.fn(),
    scale: vi.fn((x: number, y: number) => { lastScale = [lastScale[0] * x, lastScale[1] * y]; }),
    rotate: vi.fn(), drawImage: vi.fn(),
    createLinearGradient: vi.fn(() => gradient), createRadialGradient: vi.fn(() => gradient),
  };
  return Object.assign(context, { draws, brandStrokes }) as unknown as CanvasRenderingContext2D & {
    fillText: ReturnType<typeof vi.fn>;
    drawImage: ReturnType<typeof vi.fn>;
    draws: typeof draws;
    brandStrokes: typeof brandStrokes;
  };
}

function renderRecordingContext(options: Parameters<typeof renderShareCardToCanvas>[0]) {
  const context = createRecordingCanvasContext();
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
  renderShareCardToCanvas(options);
  getContext.mockRestore();
  return context;
}

function renderedText(options: Parameters<typeof renderShareCardToCanvas>[0]) {
  return renderRecordingContext(options).draws.map(({ text }) => text).join('');
}

describe('shareCardRenderer scene contract', () => {
  it.each(LAYOUT_KEYS)('%s 的页脚使用统一矢量，并跟随海报文字前景色', (layout) => {
    const context = renderRecordingContext({ stats: MOCK_STATS, range: 'week', scope: 'local', layout });
    const wordmark = context.draws.find(({ text }) => text === 'TokenLedger');
    expect(wordmark).toBeDefined();
    expect(context.brandStrokes).toEqual([{
      source: TOKEN_LEDGER_PATH,
      color: wordmark!.color,
      width: TOKEN_LEDGER_STROKE_WIDTH,
      cap: 'round',
      join: 'round',
      scale: layout === 'scorecard' ? [51 / 24, 51 / 24] : [52 / 24, 52 / 24],
    }]);
  });

  it('保留五个历史 ID，同时把选择器映射到五套新视觉', () => {
    expect(LAYOUT_KEYS).toEqual(['scorecard', 'journal', 'achievement', 'receipt', 'signal']);
    expect(LAYOUT_KEYS.map((key) => SHARE_LAYOUTS[key].name)).toEqual(['编辑宣言', 'AI 搭子', '流光档案', '月度通行证', '像素存档']);
    for (const layout of LAYOUT_KEYS) {
      const scene = buildShareCardScene({ stats: MOCK_STATS, range: 'week', scope: 'local', layout });
      expect(scene).toMatchObject({ width: 1080, height: 1920, layout });
    }
  });

  it('五套区域签名互不相同且都在 1080×1920 安全画布内', () => {
    const signatures = new Set<string>();
    for (const layout of LAYOUT_KEYS) {
      const scene = buildShareCardScene({ stats: MOCK_STATS, range: 'week', scope: 'local', layout });
      expect(scene.regions.length).toBeGreaterThanOrEqual(5);
      scene.regions.forEach((region) => {
        expect(region.x).toBeGreaterThanOrEqual(0);
        expect(region.y).toBeGreaterThanOrEqual(0);
        expect(region.width).toBeGreaterThan(0);
        expect(region.height).toBeGreaterThan(0);
        expect(region.x + region.width).toBeLessThanOrEqual(SHARE_CARD_WIDTH);
        expect(region.y + region.height).toBeLessThanOrEqual(SHARE_CARD_HEIGHT);
      });
      signatures.add(scene.regions.map((region) => region.id).join('|'));
    }
    expect(signatures.size).toBe(5);
  });

  it('关键文本来自纯摘要，不携带账号、设备或会话身份', () => {
    const scene = buildShareCardScene({ stats: MOCK_STATS, range: 'all', scope: 'cloud', layout: 'receipt' });
    expect(scene.keyTexts).toContain('AI 协作里程碑');
    expect(scene.keyTexts).toContain('数据来自已同步账本');
    expect(scene.keyTexts.join(' ')).not.toMatch(/email|machine|session|device|@/i);
  });

  it('合并缓存只展示总量，不伪造复用率或节省金额', () => {
    const combinedOnly: StatsData = {
      ...MOCK_STATS,
      summary: { ...MOCK_STATS.summary, cacheReadTokens: undefined, cacheWriteTokens: undefined },
    };
    const summary = buildShareCardScene({ stats: combinedOnly, range: 'week', scope: 'local', layout: 'scorecard' }).summary;
    expect(summary.cachedTokens).toBe(1_200_000);
    expect(summary.cacheReusePercent).toBeNull();
    expect(summary.cacheNetSavedUsd).toBeNull();
  });

  it('只有编辑宣言在允许时画缓存净节省，隐藏费用后五套均无美元', () => {
    const visible = renderedText({ stats: MOCK_STATS, range: 'week', scope: 'local', layout: 'scorecard', hideCosts: false });
    expect(visible).toContain('缓存净节省');
    expect(visible).toContain('≈$40.00');
    for (const layout of LAYOUT_KEYS) {
      const hidden = renderedText({ stats: MOCK_STATS, range: 'week', scope: 'local', layout, hideCosts: true });
      expect(hidden).not.toContain('$');
    }
    expect(shareCardCostFacts('scorecard', { cacheNetSavedUsd: 45.2 })).toEqual(['缓存净节省']);
    expect(shareCardCostFacts('scorecard', { cacheNetSavedUsd: null })).toEqual([]);
    LAYOUT_KEYS.filter((key) => key !== 'scorecard').forEach((layout) => {
      expect(shareCardCostFacts(layout, { cacheNetSavedUsd: 45.2 })).toEqual([]);
    });
  });

  it('沿用随包授权字体，并登记唯一无字液态底图', () => {
    expect(new Set(Object.values(SHARE_FONT_FAMILIES)).size).toBe(5);
    expect(Object.values(SHARE_FONT_FAMILIES).every((family) => family.includes('TokenLedger Share'))).toBe(true);
    expect(SHARE_FONT_FAMILIES.number).toContain('Noto Sans CJK SC');
    expect(SHARE_FONT_FAMILIES.receiptPixel).toContain('sans-serif');
    expect(SHARE_FONT_LOAD_SPECS).toHaveLength(8);
    expect(SHARE_BACKGROUND_ASSETS).toHaveLength(1);
    expect(SHARE_BACKGROUND_ASSETS[0].key).toBe('liquid-archive');
    expect(SHARE_BACKGROUND_ASSETS[0].url).toMatch(/liquid-archive\.png$/);
    expect(SHARE_TYPOGRAPHY.signal.hero.family).toBe(SHARE_FONT_FAMILIES.receiptPixel);
    expect(SHARE_HERO_RENDERING.signal).toBe('uniform-fit');
  });

  it('设计框、footer 与主字号留在画布内并保留传播级层次', () => {
    Object.values(SHARE_TEXT_BOXES).flatMap((roles) => Object.values(roles)).forEach(([x, y, width, height]) => {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + width).toBeLessThanOrEqual(SHARE_CARD_WIDTH);
      expect(y + height).toBeLessThanOrEqual(SHARE_CARD_HEIGHT);
    });
    expect(SHARE_TYPOGRAPHY.scorecard.hero.size).toBeGreaterThanOrEqual(340);
    expect(SHARE_TYPOGRAPHY.receipt.hero.size).toBeGreaterThanOrEqual(380);
    expect(SHARE_TYPOGRAPHY.signal.hero.size).toBeGreaterThanOrEqual(280);
    Object.values(SHARE_FOOTER_ANCHORS).forEach((anchor) => expect(anchor.metaTop).toBeLessThan(SHARE_CARD_HEIGHT));
  });

  it('五套画布有各自视觉文案而不是仅换配色', () => {
    const texts = Object.fromEntries(LAYOUT_KEYS.map((layout) => [layout, renderedText({ stats: MOCK_STATS, range: 'month', scope: 'local', layout, hideCosts: false })]));
    expect(texts.scorecard).toContain('这个月和 AI 一起');
    expect(texts.journal).toContain('我的 AI 搭子MONTHLY MIX');
    expect(texts.achievement).toContain('我与 AI 的八月COLLABORATION ARCHIVE');
    expect(texts.receipt).toContain('八月通行证MONTHLY PASS');
    expect(texts.signal).toContain('八月存档MONTHLY MIX SAVE');
  });

  it('标题随 today/week/month/year/all/custom 改变，不硬编码九月演示图', () => {
    const cases: Array<[Parameters<typeof buildShareCardScene>[0]['range'], string]> = [
      ['today', '今天'], ['week', '这周'], ['month', '这个月'], ['year', '今年'], ['all', '一路以来'], ['custom', '这段时间'],
    ];
    cases.forEach(([range, expected]) => {
      const text = renderedText({ stats: MOCK_STATS, range, scope: 'local', layout: 'scorecard' });
      expect(text).toContain(expected);
      expect(text).not.toContain('九月');
    });
  });

  it('未知活跃天明确降级，绝不伪造成 1 天', () => {
    const unknownDays: StatsData = { ...MOCK_STATS, meta: {} };
    for (const layout of ['achievement', 'receipt', 'signal'] as const) {
      const text = renderedText({ stats: unknownDays, range: 'week', scope: 'local', layout });
      expect(text).toContain(layout === 'signal' ? '天数未知' : '活跃天数未提供');
      expect(text).not.toContain('1 天');
    }
  });

  it('所有模板都显示动态值，压力夹具不会出现 NaN/Infinity 或演示数', () => {
    const longName = '超长中文模型名-Reasoning-Preview-'.repeat(6);
    const stress: StatsData = {
      ...MOCK_STATS,
      summary: {
        ...MOCK_STATS.summary,
        totalTokens: 999_999_999,
        inputTokens: 800_000_001,
        outputTokens: 199_999_998,
        cachedTokens: 88_888_888,
        totalRequests: 999_999,
      },
      tools: { long: { ...MOCK_STATS.tools.codex, name: longName, total: 999_999_999, input: 800_000_001, output: 199_999_998 } },
      models: { long: { ...MOCK_STATS.models.gpt, name: longName, total: 999_999_999, input: 800_000_001, output: 199_999_998 } },
      comparison: {
        window: { kind: 'monthOverMonth', timezone: 'Asia/Shanghai', bucket: 'day', currentStart: '2026-09-01T00:00:00+08:00', currentEnd: '2026-09-30T23:59:59+08:00', previousStart: '2026-08-01T00:00:00+08:00', previousEnd: '2026-08-31T23:59:59+08:00', alignedThrough: '2026-09-30T23:59:59+08:00' },
        current: { summary: { ...MOCK_STATS.summary, totalTokens: 999_999_999, inputTokens: 800_000_001, outputTokens: 199_999_998, totalCost: 10 }, series: [] },
        previous: { summary: { ...MOCK_STATS.summary, totalTokens: 1_200_000_000, inputTokens: 950_000_000, outputTokens: 250_000_000, totalCost: 12 }, series: [] },
        delta: {
          tokens: { absolute: -200_000_001, percent: 16.7, direction: 'down' },
          requests: { absolute: -20, percent: 3, direction: 'down' },
          cost: { absolute: -2, percent: 16.7, direction: 'down' },
        },
      },
    };
    for (const layout of LAYOUT_KEYS) {
      const text = renderedText({ stats: stress, range: 'month', scope: 'cloud', layout });
      expect(text).toContain('1.00B');
      expect(text).not.toMatch(/NaN|Infinity|12\.8M|640/);
    }
  });

  it('超长主力名称与页脚元数据省略到安全范围', () => {
    const longName = '超长主力名称'.repeat(40);
    const longStats: StatsData = {
      ...MOCK_STATS,
      tools: { codex: { ...MOCK_STATS.tools.codex, name: longName } },
      meta: { ...MOCK_STATS.meta, generatedAt: '2026-08-16T18:00:00+08:00'.repeat(20) },
    };
    const text = renderedText({ stats: longStats, range: 'week', scope: 'local', layout: 'scorecard', appVersion: '1.2.76-long-build'.repeat(20) });
    expect(text).toContain('…');
    expect(text).toContain('数据来自');
  });

  it('液态底图失败只阻断流光档案，其他四版继续可用且重试可恢复', async () => {
    vi.resetModules();
    const isolated = await import('./shareCardRenderer');
    const OriginalImage = globalThis.Image;
    let failNextImage = false;
    class ControlledImage {
      complete = false;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        if (failNextImage) queueMicrotask(() => this.onerror?.());
        else { this.complete = true; queueMicrotask(() => this.onload?.()); }
      }
    }
    vi.stubGlobal('Image', ControlledImage);
    try {
      await expect(isolated.ensureShareCardAssetsReady('scorecard')).resolves.toBeUndefined();
      failNextImage = true;
      await expect(isolated.ensureShareCardAssetsReady('achievement')).rejects.toThrow('liquid archive');
      await expect(isolated.ensureShareCardAssetsReady('signal')).resolves.toBeUndefined();
      failNextImage = false;
      await expect(isolated.ensureShareCardAssetsReady('achievement')).resolves.toBeUndefined();
      const context = createRecordingCanvasContext();
      const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
      isolated.renderShareCardToCanvas({ stats: MOCK_STATS, range: 'month', scope: 'local', layout: 'achievement' });
      getContext.mockRestore();
      expect(context.drawImage).toHaveBeenCalled();
    } finally {
      vi.stubGlobal('Image', OriginalImage);
    }
  });

  it('资产预载后深蓝版在同一个生产 renderer 内绘制无字底图', async () => {
    const OriginalImage = globalThis.Image;
    class ImmediateImage {
      complete = false;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { this.complete = true; queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', ImmediateImage);
    try {
      await ensureShareCardAssetsReady('achievement');
      const context = renderRecordingContext({ stats: MOCK_STATS, range: 'month', scope: 'local', layout: 'achievement' });
      expect(context.drawImage).toHaveBeenCalled();
    } finally {
      vi.stubGlobal('Image', OriginalImage);
    }
  });

  it('footer 分两行完整保留 source、stale、隐藏费用与版本号', () => {
    const stale: StatsData = { ...MOCK_STATS, meta: { ...MOCK_STATS.meta, stale: true } };
    for (const layout of LAYOUT_KEYS) {
      const context = renderRecordingContext({ stats: stale, range: 'month', scope: 'cloud', layout, hideCosts: true, appVersion: '1.2.77' });
      const footer = context.draws.filter(({ y }) => y >= 1810).map(({ text }) => text).join('');
      expect(footer).toContain('数据来自已同步账本');
      expect(footer).toContain('缓存快照');
      expect(footer).toContain('费用已隐藏');
      expect(footer).toContain('v1.2.77');
      expect(footer).not.toContain('…');
    }
  });

  it('真实 Canvas 导出入口锁定 1080×1920', () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(createRecordingCanvasContext());
    const canvas = renderShareCardToCanvas({ stats: MOCK_STATS, range: 'week', scope: 'local', layout: 'signal' });
    expect(canvas.width).toBe(1080);
    expect(canvas.height).toBe(1920);
    expect(getContext).toHaveBeenCalledWith('2d');
    getContext.mockRestore();
  });

  it('五套场景沿用同一修正后的榜首占比，实际赤黑版也画出 36%', () => {
    for (const layout of LAYOUT_KEYS) {
      const scene = buildShareCardScene({ stats: SHARE_LEADER_FIXTURE_STATS, range: 'week', scope: 'local', layout });
      expect(scene.summary.topTool).toEqual({ name: 'Codex CLI', tokens: 357_800, sharePercent: 36 });
      expect(scene.keyTexts).toContain('占 36%');
      expect(scene.keyTexts).not.toContain('占 10%');
    }
    const text = renderedText({ stats: SHARE_LEADER_FIXTURE_STATS, range: 'week', scope: 'local', layout: 'scorecard' });
    expect(text).toContain('占 36%');
    expect(text).not.toContain('占 10%');
  });
});

describe('T10.253 预览与PNG同源、隐私和期间边界', () => {
  it.each(LAYOUT_KEYS)('%s 的可读预览和PNG入口调用同一renderer，绘制命令完全一致', async (layout) => {
    await ensureShareCardAssetsReady(layout);
    const options = { stats: MOCK_STATS, range: 'week' as const, scope: 'cloud' as const, layout, hideCosts: true, appVersion: '1.2.77' };
    const preview = renderRecordingContext(options);
    const exported = createRecordingCanvasContext();
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(exported);
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, type) {
      expect(this.width).toBe(1080);
      expect(this.height).toBe(1920);
      callback(new Blob(['recording-renderer-test'], { type }));
    });
    try {
      const blob = await exportShareCardBlob(options);
      expect(blob.type).toBe('image/png');
      expect(exported.draws).toEqual(preview.draws);
      expect(exported.brandStrokes).toEqual(preview.brandStrokes);
      expect(exported.drawImage.mock.calls).toEqual(preview.drawImage.mock.calls);
      expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
    } finally {
      getContext.mockRestore();
      toBlob.mockRestore();
    }
  });

  it('画布不可用时明确失败，不能导出空白成功图', async () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    try {
      const options = { stats: MOCK_STATS, range: 'week' as const, scope: 'local' as const };
      expect(() => renderShareCardToCanvas(options)).toThrow('无法创建海报画布');
      await expect(exportShareCardBlob(options)).rejects.toThrow('无法创建海报画布');
    } finally {
      getContext.mockRestore();
    }
  });

  it.each(LAYOUT_KEYS)('%s 不接收身份、项目、会话或隐藏金额，未知费用也不会变0', (layout) => {
    const privateStats = {
      ...MOCK_STATS,
      summary: { ...MOCK_STATS.summary, totalCost: Number.NaN },
      machines: ['PRIVATE_DEVICE_ID'],
      history: [{ email: 'private@example.com', machineId: 'PRIVATE_DEVICE_ID', sessionId: 'PRIVATE_SESSION', project: '/home/private-project', apiUrl: 'https://private.example.com/api' }],
      meta: { ...MOCK_STATS.meta, machine: 'PRIVATE_DEVICE_ID', query: {
        range: 'week', timezone: 'Asia/Shanghai', machines: ['PRIVATE_DEVICE_ID'], tools: [], models: [], search: 'PRIVATE_PROJECT', tokenMode: 'effective',
      } },
    } as unknown as StatsData;
    const options = { stats: privateStats, range: 'week' as const, scope: 'cloud' as const, layout, hideCosts: true };
    const scene = buildShareCardScene(options);
    const projection = JSON.stringify(scene);
    const text = renderedText(options);
    expect(scene.summary.totalCostUsd).toBeNull();
    expect(scene.summary.cacheNetSavedUsd).toBeNull();
    expect(`${projection}${text}`).not.toMatch(/PRIVATE_|private@example|private-project|private\.example|128\.45|45\.2|\$/);
    expect(text).toContain('费用已隐藏');
    expect(buildShareCardScene({ ...options, hideCosts: false }).summary.totalCostUsd).toBeNull();
  });

  it.each(LAYOUT_KEYS)('%s 真实绘制custom query日期，并在无来源时诚实标为未知', (layout) => {
    const custom: StatsData = { ...MOCK_STATS, meta: { ...MOCK_STATS.meta, range: 'custom', query: {
      range: 'custom', timezone: 'Asia/Shanghai', start: '2026-07-01', end: '2026-07-03', machines: [], tools: [], models: [], search: null, tokenMode: 'effective',
    } } };
    const text = renderedText({ stats: custom, range: 'custom', scope: 'cloud', layout });
    expect(text).toContain(layout === 'signal' ? '2026.7.1—2026.7.3' : '2026年7月1日—2026年7月3日');
    const unknown = renderedText({ stats: { ...MOCK_STATS, meta: {} }, range: 'today', scope: 'cloud', layout, now: new Date('2030-12-31T00:00:00Z') });
    expect(unknown).toContain('统计期间未提供');
    expect(unknown).not.toContain('2030');
  });

  it('票根非月范围不再声称MONTHLY PASS', () => {
    for (const range of ['today', 'week', 'year', 'all', 'custom'] as const) {
      expect(renderedText({ stats: MOCK_STATS, range, scope: 'local', layout: 'receipt' })).not.toContain('MONTHLY PASS');
    }
  });

  it('正微小净节省保留小于阈值语义，不显示货币零或旧毛值', () => {
    const tiny: StatsData = { ...MOCK_STATS, summary: {
      ...MOCK_STATS.summary, cacheSavedUsd: 0.006,
      cacheSavings: { readSavedUsd: 0.006, writePremiumUsd: 0.002, netSavedUsd: 0.004, fallbackPricedReadTokens: 0, fallbackPricedWriteTokens: 0, priceBasis: 'local-prices' },
    } };
    const text = renderedText({ stats: tiny, range: 'week', scope: 'local', layout: 'scorecard', hideCosts: false });
    expect(text).toContain('缓存净节省<$0.01');
    expect(text).not.toContain('≈$0.00');
  });
});

describe('T10.253 fallback字体测量边界', () => {
  it('混合CJK长名的短ink bbox不得使journal蓝圈文字居中后向右裁断', () => {
    const fixture: StatsData = { ...MOCK_STATS, tools: {
      codex: { ...MOCK_STATS.tools.codex, name: '超长中文模型名-Reasoning-Preview-'.repeat(6) },
    } };
    const context = createRecordingCanvasContext();
    const originalMeasure = vi.mocked(context.measureText).getMockImplementation()!;
    vi.spyOn(context, 'measureText').mockImplementation((text) => {
      const metrics = originalMeasure(text);
      if (!text.includes('超长中文')) return metrics;
      const size = Number(/([\d.]+)px/.exec(context.font)![1]);
      return { ...metrics, width: 350.170013 * Array.from(text).length / 10 * size / 38, actualBoundingBoxLeft: size / 38, actualBoundingBoxRight: 39 * size / 38 };
    });
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    try {
      renderShareCardToCanvas({ stats: fixture, range: 'month', scope: 'local', layout: 'journal' });
      const name = context.draws.find(({ text }) => text.startsWith('超长中文模型名-'));
      expect(name?.text).toMatch(/…$/);
      expect(name).toBeDefined();
      const size = Number(/([\d.]+)px/.exec(name!.font)![1]);
      expect(name!.x - size / 38).toBeGreaterThanOrEqual(48);
      expect(name!.x + 350.170013 * Array.from(name!.text).length / 10 * size / 38).toBeLessThanOrEqual(48 + 470);
      expect(name!.scale).toEqual([1, 1]);
    } finally {
      getContext.mockRestore();
    }
  });

  it('正常Latin名字保持原字号与居中位置，不水平拉伸', () => {
    const context = renderRecordingContext({ stats: MOCK_STATS, range: 'month', scope: 'local', layout: 'journal' });
    const name = context.draws.find(({ text }) => text === 'Codex CLI');
    expect(name?.font).toContain('900 38px');
    expect(name?.x).toBeCloseTo(48 + (470 - 'Codex CLI'.length * 38 * 0.62) / 2);
    expect(name?.scale).toEqual([1, 1]);
  });

  it.each([
    { layout: 'journal' as const, range: 'all' as const, x: 52, y: 350, width: 640, height: 64 },
    { layout: 'signal' as const, range: 'month' as const, x: 54, y: 368, width: 974, height: 250 },
  ])('$layout 的正负tracking都按每字advance约束右边界', ({ layout, range, x, y, width, height }) => {
    const fixture: StatsData = { ...MOCK_STATS, summary: { ...MOCK_STATS.summary, inputTokens: 99_000_000_000, outputTokens: 999_999_999 } };
    const context = createRecordingCanvasContext();
    const originalMeasure = vi.mocked(context.measureText).getMockImplementation()!;
    vi.spyOn(context, 'measureText').mockImplementation((text) => {
      const metrics = originalMeasure(text);
      return { ...metrics, actualBoundingBoxRight: metrics.width * 0.1 };
    });
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    try {
      renderShareCardToCanvas({ stats: fixture, range, scope: 'local', layout });
      const glyphs = context.draws.filter((draw) => draw.y >= y && draw.y <= y + height);
      expect(glyphs.length).toBeGreaterThan(1);
      for (const glyph of glyphs) {
        const size = Number(/([\d.]+)px/.exec(glyph.font)![1]);
        expect(glyph.x).toBeGreaterThanOrEqual(x);
        expect(glyph.x + Array.from(glyph.text).length * size * 0.62).toBeLessThanOrEqual(x + width + 0.001);
        expect(glyph.scale).toEqual([1, 1]);
      }
    } finally {
      getContext.mockRestore();
    }
  });
});


describe('T10.253 像素存档未知天数避让', () => {
  it('未知天数的文字盒止于644，不进入650起的地景，已知态位置不变', () => {
    const unknown = renderRecordingContext({ stats: { ...MOCK_STATS, meta: {} }, range: 'week', scope: 'local', layout: 'signal' });
    expect(unknown.rect).toHaveBeenCalledWith(516, 860, 128, 52);
    const label = unknown.draws.find(({ text }) => text === '天数未知');
    expect(label).toBeDefined();
    const size = Number(/([\d.]+)px/.exec(label!.font)![1]);
    expect(label!.x + Array.from(label!.text).length * size * 0.62).toBeLessThanOrEqual(644);
    expect(516 + 128).toBeLessThan(650);
    const known = renderRecordingContext({ stats: MOCK_STATS, range: 'week', scope: 'local', layout: 'signal' });
    expect(known.rect).toHaveBeenCalledWith(516, 860, 420, 52);
    expect(known.draws.some(({ text }) => text === '活跃天')).toBe(true);
  });
});


describe('T10.253 离线期间完整可读', () => {
  it('像素存档紧凑日期保留custom两端，scene完整中文日期不变', () => {
    const fixture: StatsData = { ...MOCK_STATS, meta: { ...MOCK_STATS.meta, range: 'custom', query: {
      range: 'custom', timezone: 'Asia/Shanghai', start: '2026-09-01', end: '2026-09-18', machines: [], tools: [], models: [], search: null, tokenMode: 'effective',
    } } };
    const options = { stats: fixture, range: 'custom' as const, scope: 'local' as const, layout: 'signal' as const };
    const heading = renderRecordingContext(options).draws.filter(({ y }) => y < 140).map(({ text }) => text).join('');
    expect(heading).toContain('2026.9.1—2026.9.18');
    expect(heading).not.toContain('…');
    expect(buildShareCardScene(options).summary.periodLabel).toBe('2026年9月1日—2026年9月18日');
  });

  it('全部范围票根用完整ARCHIVE PASS，不截断长英文副题', () => {
    const text = renderedText({ stats: MOCK_STATS, range: 'all', scope: 'local', layout: 'receipt' });
    expect(text).toContain('ARCHIVE PASS');
    expect(text).not.toContain('COLLABORATION ARCHIVE PASS');
  });
});


describe('T10.253 主力名称按真实文字盒适配', () => {
  it.each(LAYOUT_KEYS)('%s 完整绘制普通Claude工具和模型名，不预先按字符数截短', (layout) => {
    const fixture: StatsData = { ...MOCK_STATS,
      tools: { claude: { ...MOCK_STATS.tools.codex, name: 'Claude Code' } },
      models: { opus: { ...MOCK_STATS.models.gpt, name: 'Claude Opus 4.1' } },
    };
    const text = renderedText({ stats: fixture, range: 'month', scope: 'local', layout });
    expect(text).toContain('Claude Code');
    expect(text).toContain('Claude Opus 4.1');
    expect(text).not.toContain('Claude Co…');
    expect(text).not.toContain('Claude Op…');
  });

  const nameBoxes: Record<ShareLayoutKey, Array<[number, number, number, number]>> = {
    scorecard: [[56, 1628, 900, 38], [56, 1670, 900, 38]],
    journal: [[48, 560, 470, 74], [350, 1050, 610, 70]],
    achievement: [[84, 1646, 430, 52], [566, 1646, 430, 52]],
    receipt: [[520, 1518, 454, 54], [520, 1604, 454, 54]],
    signal: [[420, 1484, 596, 58], [420, 1576, 596, 58]],
  };

  it.each(LAYOUT_KEYS)('%s 超长CJK仍在现有文字盒内省略并保持等比字形', (layout) => {
    const longName = '超长中文模型名-Reasoning-Preview-'.repeat(30);
    const fixture: StatsData = { ...MOCK_STATS,
      tools: { long: { ...MOCK_STATS.tools.codex, name: longName } },
      models: { long: { ...MOCK_STATS.models.gpt, name: longName } },
    };
    const context = renderRecordingContext({ stats: fixture, range: 'month', scope: 'local', layout });
    for (const [x, y, width, height] of nameBoxes[layout]) {
      expect(context.rect).toHaveBeenCalledWith(x, y, width, height);
      const nameDraws = context.draws.filter((draw) => draw.x >= x && draw.x < x + width && draw.y >= y && draw.y <= y + height);
      expect(nameDraws.map(({ text }) => text).join('')).toContain('…');
      for (const draw of nameDraws) {
        const size = Number(/([\d.]+)px/.exec(draw.font)![1]);
        expect(size).toBeGreaterThanOrEqual(24);
        expect(draw.x + Array.from(draw.text).length * size * 0.62).toBeLessThanOrEqual(x + width + 0.001);
        expect(draw.scale).toEqual([1, 1]);
      }
    }
  });
});


describe('T10.253 长名称保留Token占比', () => {
  it.each(['scorecard', 'achievement'] as const)('%s 只省略长名，后置100%%仍完整且在文字盒内', (layout) => {
    const longName = '超长中文模型名-Reasoning-Preview-'.repeat(30);
    const usage = { input: MOCK_STATS.summary.inputTokens, output: MOCK_STATS.summary.outputTokens };
    const fixture: StatsData = { ...MOCK_STATS,
      tools: { long: { ...MOCK_STATS.tools.codex, ...usage, name: longName } },
      models: { long: { ...MOCK_STATS.models.gpt, ...usage, name: longName } },
    };
    const context = renderRecordingContext({ stats: fixture, range: 'month', scope: 'local', layout });
    const boxes = layout === 'scorecard' ? [[56, 1628, 900, 38]] : [[84, 1646, 430, 52], [566, 1646, 430, 52]];
    for (const [x, y, width, height] of boxes) {
      const names = context.draws.filter((draw) => draw.x >= x && draw.x < x + width && draw.y >= y && draw.y <= y + height);
      expect(names).toHaveLength(1);
      expect(names[0].text).toContain('…');
      expect(names[0].text).toMatch(layout === 'scorecard' ? /占 100%$/ : /100%$/);
      const size = Number(/([\d.]+)px/.exec(names[0].font)![1]);
      expect(names[0].x + Array.from(names[0].text).length * size * 0.62).toBeLessThanOrEqual(x + width + 0.001);
      expect(names[0].scale).toEqual([1, 1]);
    }
  });
});
