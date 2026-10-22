import { describe, expect, it } from 'vitest';
import type { StatsData, UsageComparison } from '../types';
import { generateVisualDigestHtml, isCloudComparisonBaselineUnverifiedLocal, resolveEffectiveCustomRange } from './reportExport';
import { isCloudComparisonBaselineUnverified } from '../components/TrendPanel';

const baseStats: StatsData = {
  summary: {
    totalTokens: 1_200,
    inputTokens: 900,
    outputTokens: 300,
    cachedTokens: 400,
    cacheReadTokens: 350,
    cacheWriteTokens: 50,
    cacheSavedUsd: 1.25,
    totalCost: 2.5,
    totalRequests: 3,
    avgTokensPerReq: 400,
  },
  tools: {
    codex: { name: 'Codex CLI', input: 900, output: 300, cached: 400, total: 1_600, cost: 2.5, requests: 3 },
  },
  models: {
    gpt: { name: 'GPT-5', input: 900, output: 300, cached: 400, total: 1_600, cost: 2.5, requests: 3 },
  },
  trends: [],
  heatmap: {},
  history: [],
};

function report(stats: StatsData = baseStats) {
  return generateVisualDigestHtml({
    stats,
    range: 'week',
    scope: 'local',
    appVersion: '1.2.3',
    generatedAt: '2026-09-05 10:00',
  });
}

describe('generateVisualDigestHtml', () => {
  it('保留真实零值，不把零成本误写为不可得', () => {
    const stats = {
      ...baseStats,
      summary: { ...baseStats.summary, totalCost: 0, cacheSavedUsd: 0 },
      models: {
        free: { name: '本地模型', input: 900, output: 300, cached: 400, total: 1_600, cost: 0, requests: 3 },
      },
    };

    const html = report(stats);
    expect(html).toContain('≈$0.00');
    expect(html).toContain('缓存读取节省 ≈$0.00');
  });

  it('核心统计未知时拒绝导出，不用 0 伪装', () => {
    const stats = {
      ...baseStats,
      summary: { ...baseStats.summary, inputTokens: Number.NaN },
    } as unknown as StatsData;

    expect(() => report(stats)).toThrow('summary.inputTokens');
  });

  it('转义名称，并为长名称提供响应式换行和排行条', () => {
    const name = 'very-long-model-name-without-any-breaks-0123456789-<script>alert(1)</script>';
    const stats: StatsData = {
      ...baseStats,
      tools: [{ name, input: 900, output: 300, cached: 400, total: 1_600, cost: 2.5, requests: 3 }],
      models: [{ name, input: 900, output: 300, cached: 400, total: 1_600, cost: 2.5, requests: 3 }],
    } as unknown as StatsData;

    const html = report(stats);
    expect(html).toContain('very-long-model-name-without-any-breaks-0123456789-&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('overflow-wrap: anywhere');
    expect(html).toContain('class="rank-bar"');
    expect(html).toContain('overflow-x: auto');
  });

  it('明确标注 stale 快照，并让打印保持明亮且不裁切表格', () => {
    const html = report({ ...baseStats, meta: { stale: true } });

    expect(html).toContain('数据状态：缓存快照（可能不是最新）');
    expect(html).toContain('print-color-adjust: exact');
    expect(html).toContain('.table-container { overflow: visible; }');
    expect(html).not.toContain('🛠️');
    expect(html).not.toContain('缓存能效评估');
  });

  it('默认使用浅色纸张编辑排版，突出有效 Token 而不以颜色暗示金额成功', () => {
    const html = report();

    expect(html).toContain('--paper: #f6f3ed');
    expect(html).toContain('class="brand-kicker">TokenLedger');
    expect(html).toContain('本周 AI 协作简报');
    expect(html).toContain('class="kpi-card kpi-card-primary"');
    expect(html).toContain('.kpi-card-primary .kpi-value { color: var(--accent)');
    expect(html).not.toContain('linear-gradient');
    expect(html).not.toContain('var(--success)');
  });

  it('KPI 标签统一改名为「预估费用」，不再使用旧名「预估总成本」（T10.154 命名，Q11）', () => {
    const html = report();
    expect(html).toContain('预估费用');
    expect(html).not.toContain('预估总成本');
  });

  it('抬头、KPI、缓存观察与模型表统一叫法（T10.154 D59–D62）', () => {
    const html = report();
    expect(html).toContain('<p class="brand-sub">当前范围的输入、输出、缓存与预估费用（按价格表估算，非账单）</p>');
    expect(html).toContain('<div class="kpi-sub">缓存净节省不可得</div>');
    expect(html).toContain('命中缓存读 350 Tokens · 写入 50 Tokens。缓存读取节省 ≈$1.25；写入溢价与净节省不可得（按价格表估算，非账单）。');
    expect(html).toContain('<h2 class="section-title">模型费用分布</h2>');
    expect(html).toContain('<th scope="col" class="num">费用占比</th>');
    expect(html).not.toMatch(/估算节省|节省估算|节省金额|金额占比|模型消耗与金额|供应商账单|（估算）/);

    const noSavings = report({ ...baseStats, summary: { ...baseStats.summary, cacheSavedUsd: undefined } });
    expect(noSavings).toContain('<div class="kpi-sub">缓存净节省不可得</div>');
    expect(noSavings).toContain('缓存净节省明细不可得');
    const combined = report({ ...baseStats, summary: { ...baseStats.summary, cacheReadTokens: undefined, cacheWriteTokens: undefined } });
    expect(combined).toContain('来源未提供读写拆分，不显示流向、复用率或缓存净节省。');
  });

  it('简报页脚补方案 §4.9 第一句「预估费用按价格表估算，非账单」，隐藏费用时仍显示（T10.186 评审待定点 3）', () => {
    const html = report();
    expect(html).toContain('<footer class="report-footer">');
    expect(html).toContain('预估费用按价格表估算，非账单。');

    const hidden = generateVisualDigestHtml({
      stats: baseStats,
      range: 'week',
      scope: 'local',
      appVersion: '1.2.3',
      generatedAt: '2026-09-05 10:00',
      hideCosts: true,
    });
    expect(hidden).toContain('预估费用按价格表估算，非账单。');
  });

  it('工具排行新增预估费用列，直接读 tools[].cost；缺失或非法费用显示"不可得"，不落回 0（Q11）', () => {
    const html = report();
    const toolSection = html.slice(html.indexOf('工具消耗排行'), html.indexOf('模型费用分布'));
    expect(toolSection).toContain('<th scope="col" class="num">预估费用</th>');
    expect(toolSection).toMatch(/Codex CLI[\s\S]*≈\$2\.50/);

    const noCostStats: StatsData = {
      ...baseStats,
      tools: { codex: { ...baseStats.tools.codex, cost: undefined as unknown as number } },
    };
    const html2 = report(noCostStats);
    const toolSection2 = html2.slice(html2.indexOf('工具消耗排行'), html2.indexOf('模型费用分布'));
    expect(toolSection2).toMatch(/Codex CLI[\s\S]*<td class="num cost-cell">不可得<\/td>/);
  });

  it('提供 comparison 时按 delta 展示同期变化；未提供 comparison 时整行不出现，不伪造 0%（Q11）', () => {
    const withComparison: StatsData = {
      ...baseStats,
      comparison: {
        window: {
          kind: 'weekOverWeek', timezone: 'UTC', bucket: 'day',
          currentStart: '2026-08-30', currentEnd: '2026-09-05',
          previousStart: '2026-08-23', previousEnd: '2026-08-29', alignedThrough: '2026-09-05',
        },
        current: { summary: baseStats.summary, series: [] },
        previous: { summary: baseStats.summary, series: [] },
        delta: {
          tokens: { absolute: 100, percent: 12.3, direction: 'up' },
          requests: { absolute: 1, percent: 50, direction: 'up' },
          cost: { absolute: 0.5, percent: 25, direction: 'up' },
        },
      },
    };
    const html = report(withComparison);
    expect(html).toContain('较上期 +12.3%');
    expect(html).toContain('较上期 +25.0%');
    expect(html).toContain('（较上期 +50.0%）');

    const withoutComparison = report(baseStats);
    expect(withoutComparison).not.toMatch(/较上期/);
  });

  it('隐藏金额时：KPI 与费用列一律显示"已隐藏"，Token 数字与 Token 同期变化不受影响，金额的同期变化不显示（respected everywhere，Q11）', () => {
    const withComparison: StatsData = {
      ...baseStats,
      comparison: {
        window: {
          kind: 'weekOverWeek', timezone: 'UTC', bucket: 'day',
          currentStart: '2026-08-30', currentEnd: '2026-09-05',
          previousStart: '2026-08-23', previousEnd: '2026-08-29', alignedThrough: '2026-09-05',
        },
        current: { summary: baseStats.summary, series: [] },
        previous: { summary: baseStats.summary, series: [] },
        delta: {
          tokens: { absolute: 100, percent: 12.3, direction: 'up' },
          requests: { absolute: 1, percent: 50, direction: 'up' },
          cost: { absolute: 0.5, percent: 25, direction: 'up' },
        },
      },
    };
    const html = generateVisualDigestHtml({
      stats: withComparison, range: 'week', scope: 'local', appVersion: '1.2.3',
      generatedAt: '2026-09-05 10:00', hideCosts: true,
    });
    expect(html).toContain('<span class="hidden-costs-badge">费用已隐藏</span>');
    expect(html).not.toContain('≈$2.50');
    expect(html).toContain('1.2K');
    expect(html).toContain('较上期 +12.3%');
    expect(html).not.toContain('较上期 +25.0%');
    const toolSection = html.slice(html.indexOf('工具消耗排行'), html.indexOf('模型费用分布'));
    expect(toolSection).toMatch(/<td class="num cost-cell">已隐藏<\/td>/);
    const modelSection = html.slice(html.indexOf('模型费用分布'));
    expect(modelSection).toMatch(/<td class="num cost-cell">已隐藏<\/td>/);
  });

  it('提供 dailyCosts 时渲染每日预估费用表，未知日期标"不可得"；未提供该字段时整节省略（Q11）', () => {
    const html = report();
    expect(html).not.toContain('每日预估费用');

    // 契约（dashboard-stats-v2.md §2.3）：coverage.state='complete' 时才允许某些
    // 日期是 recorded-estimate、另一些是 unavailable；这是"部分日子有金额、部分
    // 不可得"的真实场景（复核修复 P3-6：原 fixture 把 recorded-estimate 和
    // state='partial' 混在一起，是解析器根本不会放行的组合）。
    const withDaily: StatsData = {
      ...baseStats,
      dailyCosts: {
        coverage: { start: '2026-08-30', end: '2026-09-05', timezone: 'UTC', state: 'complete' },
        days: [
          { date: '2026-08-31', amountUsd: 1.2, status: 'recorded-estimate' },
          { date: '2026-09-01', amountUsd: null, status: 'unavailable', reason: 'missing-cost' },
        ],
      },
    };
    const html2 = report(withDaily);
    expect(html2).toContain('每日预估费用');
    const dailySection = html2.slice(html2.indexOf('每日预估费用'));
    expect(dailySection).toMatch(/2026-08-31[\s\S]*≈\$1\.20/);
    expect(dailySection).toMatch(/2026-09-01[\s\S]*不可得/);
    expect(dailySection).not.toContain('部分日期数据不完整');
    // 契约要求的说明层（复核修复 P3-2）：口径（未逐笔核价）与"只列活跃日"。
    expect(dailySection).toContain('未逐笔核价');
    expect(dailySection).toContain('未列出的日期在账本中没有消耗记录');
  });

  it('coverage.state=partial 时每日表所有行都不可得，并标注"部分日期数据不完整"；start 仅 all 允许为 null（Q11）', () => {
    // 契约：partial 不能展示任何日的金额，所有行必须 unavailable/incomplete-coverage；
    // start=null 仅 range='all' 允许。
    const withPartialDaily: StatsData = {
      ...baseStats,
      dailyCosts: {
        coverage: { start: null, end: '2026-09-05', timezone: 'UTC', state: 'partial' },
        days: [
          { date: '2026-09-01', amountUsd: null, status: 'unavailable', reason: 'incomplete-coverage' },
        ],
      },
    };
    const html = generateVisualDigestHtml({
      stats: withPartialDaily, range: 'all', scope: 'local', appVersion: '1.2.3', generatedAt: '2026-09-05 10:00',
    });
    const dailySection = html.slice(html.indexOf('每日预估费用'));
    expect(dailySection).toMatch(/2026-09-01[\s\S]*不可得/);
    expect(dailySection).toContain('部分日期数据不完整');
    expect(dailySection).toContain('账本最早记录');
  });

  it('每日表超过 120 行时截断为最近 120 天并如实注明，不假装完整（复核修复 P3-2）', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const days = Array.from({ length: 130 }, (_, index) => {
      const date = new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10);
      return { date, amountUsd: 1, status: 'recorded-estimate' as const };
    });
    const html = generateVisualDigestHtml({
      stats: {
        ...baseStats,
        dailyCosts: {
          coverage: { start: days[0].date, end: days[days.length - 1].date, timezone: 'UTC', state: 'complete' },
          days,
        },
      },
      range: 'all', scope: 'local', appVersion: '1.2.3', generatedAt: `${days[days.length - 1].date} 10:00`,
    });
    const dailySection = html.slice(html.indexOf('每日预估费用'));
    const rowCount = (dailySection.match(/class="num cost-cell"/g) || []).length;
    expect(rowCount).toBe(120);
    expect(dailySection).toContain('仅展示最近 120 天');
    expect(dailySection).toContain('完整明细共 130 天');
  });

  it('隐藏金额只覆盖"已知"的金额；本就"不可得"的费用不改写成"已隐藏"，因为没有数字可藏', () => {
    const mixedStats: StatsData = {
      ...baseStats,
      tools: {
        codex: { ...baseStats.tools.codex, cost: undefined as unknown as number },
      },
      models: {
        gpt: { ...baseStats.models.gpt, cost: undefined },
      },
      dailyCosts: {
        // 契约：range='week' 时 coverage.start 不能是 null（null 仅 all 允许），
        // 且 state='partial' 时行的 reason 必须是 incomplete-coverage，不能是
        // missing-cost（复核修复 P3-6：原 fixture 是解析器不会放行的组合）。
        coverage: { start: '2026-08-30', end: '2026-09-05', timezone: 'UTC', state: 'partial' },
        days: [{ date: '2026-09-05', amountUsd: null, status: 'unavailable', reason: 'incomplete-coverage' }],
      },
    };
    const html = generateVisualDigestHtml({
      stats: mixedStats, range: 'week', scope: 'local', appVersion: '1.2.3',
      generatedAt: '2026-09-05 10:00', hideCosts: true,
    });
    const toolSection = html.slice(html.indexOf('工具消耗排行'), html.indexOf('模型费用分布'));
    expect(toolSection).toMatch(/Codex CLI[\s\S]*<td class="num cost-cell">不可得<\/td>/);
    const modelSection = html.slice(html.indexOf('模型费用分布'), html.indexOf('每日预估费用'));
    expect(modelSection).toMatch(/<td class="num cost-cell">不可得<\/td>/);
    const dailySection = html.slice(html.indexOf('每日预估费用'));
    expect(dailySection).toMatch(/2026-09-05[\s\S]*不可得/);
    expect(dailySection.split('</table>')[0]).not.toContain('已隐藏');
  });

  it('隐藏金额时每日表的金额列也显示"已隐藏"', () => {
    const withDaily: StatsData = {
      ...baseStats,
      dailyCosts: {
        // range='week' 时 start 不能是 null（复核修复 P3-6）。
        coverage: { start: '2026-08-30', end: '2026-09-05', timezone: 'UTC', state: 'complete' },
        days: [{ date: '2026-09-05', amountUsd: 3, status: 'recorded-estimate' }],
      },
    };
    const html = generateVisualDigestHtml({
      stats: withDaily, range: 'week', scope: 'local', appVersion: '1.2.3',
      generatedAt: '2026-09-05 10:00', hideCosts: true,
    });
    const dailySection = html.slice(html.indexOf('每日预估费用'));
    expect(dailySection).toContain('已隐藏');
    expect(dailySection).not.toContain('≈$3.00');
  });

  describe('复核修复 P1-2：云端基线未验证时不写"较上期 新增"', () => {
    function comparisonWithZeroPrevious(): UsageComparison {
      return {
        window: {
          kind: 'weekOverWeek', timezone: 'UTC', bucket: 'day',
          currentStart: '2026-08-30', currentEnd: '2026-09-05',
          previousStart: '2026-08-23', previousEnd: '2026-08-29', alignedThrough: '2026-09-05',
        },
        current: { summary: baseStats.summary, series: [] },
        previous: {
          summary: { ...baseStats.summary, totalRequests: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0 },
          series: [],
        },
        delta: {
          tokens: { absolute: 900, percent: null, direction: 'new' },
          requests: { absolute: 3, percent: null, direction: 'new' },
          cost: { absolute: 2.5, percent: null, direction: 'new' },
        },
      };
    }

    it('本文件的判定函数与 TrendPanel 导出的同名函数在同一组输入下逐项一致（对拍测试）', () => {
      const zeroPrevious = comparisonWithZeroPrevious();
      const nonZeroPrevious: UsageComparison = {
        ...zeroPrevious,
        previous: { summary: baseStats.summary, series: [] },
      };
      const cases: Array<['local' | 'cloud', UsageComparison | null | undefined]> = [
        ['cloud', zeroPrevious],
        ['cloud', nonZeroPrevious],
        ['cloud', null],
        ['cloud', undefined],
        ['local', zeroPrevious],
        ['local', nonZeroPrevious],
      ];
      for (const [scope, comparison] of cases) {
        expect(isCloudComparisonBaselineUnverifiedLocal(scope, comparison))
          .toBe(isCloudComparisonBaselineUnverified(scope, comparison));
      }
    });

    it('云端零基线：三行同期变化都显示"基线缺失"，不是"新增"（GLB-01，看板/简报口径必须一致）', () => {
      const html = generateVisualDigestHtml({
        stats: { ...baseStats, comparison: comparisonWithZeroPrevious() },
        range: 'week', scope: 'cloud', appVersion: '1.2.3', generatedAt: '2026-09-05 10:00',
      });
      expect(html).toContain('较上期 基线缺失');
      expect(html).not.toContain('较上期 新增');
    });

    it('本地零基线不受此判定影响，继续显示"新增"（本地的零基线是真零）', () => {
      const html = generateVisualDigestHtml({
        stats: { ...baseStats, comparison: comparisonWithZeroPrevious() },
        range: 'week', scope: 'local', appVersion: '1.2.3', generatedAt: '2026-09-05 10:00',
      });
      expect(html).toContain('较上期 新增');
      expect(html).not.toContain('基线缺失');
    });

    it('云端基线未验证时，隐藏金额不会让费用那一行重新冒出"新增"或百分比', () => {
      const html = generateVisualDigestHtml({
        stats: { ...baseStats, comparison: comparisonWithZeroPrevious() },
        range: 'week', scope: 'cloud', appVersion: '1.2.3', generatedAt: '2026-09-05 10:00', hideCosts: true,
      });
      // 费用同期变化在 hideCosts 时整行省略（既有规则），不应该单独因为
      // baselineUnverified 而冒出来。
      // 抬头也写「预估费用」（T10.154 D59），这里按 KPI 标签定位费用那一格。
      const costCardIndex = html.indexOf('<div class="kpi-label">预估费用</div>');
      expect(costCardIndex).toBeGreaterThan(-1);
      const costCard = html.slice(costCardIndex, html.indexOf('Prompt 缓存复用率'));
      expect(costCard).not.toContain('基线缺失');
      expect(costCard).not.toContain('新增');
    });
  });

  describe('复核修复 P1-3：分享弹窗入口丢失自定义区间时回退到 stats.meta.query', () => {
    it('customRange 选项缺失时，标题与文件名回退到 stats.meta.query.start/end，不退化成通用占位', () => {
      const html = generateVisualDigestHtml({
        stats: {
          ...baseStats,
          meta: {
            query: {
              range: 'custom', timezone: 'UTC', machines: [], tools: [], models: [], search: null,
              tokenMode: 'effective', start: '2026-08-01', end: '2026-08-31',
            },
          },
        },
        range: 'custom', scope: 'local', appVersion: '1.2.3', generatedAt: '2026-09-01 10:00',
      });
      expect(html).toContain('8月1日—8月31日 AI 协作简报');
    });

    it('customRange 选项存在时优先使用它，不被 stats.meta.query 覆盖', () => {
      const resolved = resolveEffectiveCustomRange({
        stats: {
          ...baseStats,
          meta: {
            query: {
              range: 'custom', timezone: 'UTC', machines: [], tools: [], models: [], search: null,
              tokenMode: 'effective', start: '2099-01-01', end: '2099-01-02',
            },
          },
        },
        range: 'custom', scope: 'local', appVersion: '1.2.3',
        customRange: { start: '2026-08-01', end: '2026-08-31' },
      });
      expect(resolved).toEqual({ start: '2026-08-01', end: '2026-08-31' });
    });

    it('customRange 与 stats.meta.query 都没有日期时返回 null，标题退化成通用「自定义区间」而不是假造日期', () => {
      const resolved = resolveEffectiveCustomRange({
        stats: baseStats, range: 'custom', scope: 'local', appVersion: '1.2.3',
      });
      expect(resolved).toBeNull();
      const html = generateVisualDigestHtml({
        stats: baseStats, range: 'custom', scope: 'local', appVersion: '1.2.3', generatedAt: '2026-09-01 10:00',
      });
      expect(html).toContain('自定义区间 AI 协作简报');
    });

    it('非 custom range 时永远不读取 stats.meta.query 的日期', () => {
      const resolved = resolveEffectiveCustomRange({
        stats: {
          ...baseStats,
          meta: {
            query: {
              range: 'week', timezone: 'UTC', machines: [], tools: [], models: [], search: null,
              tokenMode: 'effective', start: '2026-08-01', end: '2026-08-31',
            },
          },
        },
        range: 'week', scope: 'local', appVersion: '1.2.3',
      });
      expect(resolved).toBeNull();
    });
  });

  it('隐藏金额时模型表改按有效 Token 降序，不再让 Token 顺序反推出金额高低（复核修复 P3-1）', () => {
    const stats: StatsData = {
      ...baseStats,
      models: {
        // 金额由高到低：expensive → mid → cheap；Token 反过来由低到高。
        expensive: { name: 'expensive-few-tokens', input: 10, output: 10, cached: 0, total: 20, cost: 9, requests: 1 },
        mid: { name: 'mid-tokens', input: 500, output: 500, cached: 0, total: 1000, cost: 5, requests: 1 },
        cheap: { name: 'cheap-many-tokens', input: 5000, output: 5000, cached: 0, total: 10000, cost: 1, requests: 1 },
      },
    };
    const visibleHtml = generateVisualDigestHtml({ stats, range: 'week', scope: 'local', appVersion: '1.2.3', generatedAt: '2026-09-05 10:00' });
    const visibleSection = visibleHtml.slice(visibleHtml.indexOf('模型费用分布'));
    // 金额可见时维持金额降序：expensive 排最前。
    expect(visibleSection.indexOf('expensive-few-tokens')).toBeLessThan(visibleSection.indexOf('cheap-many-tokens'));

    const hiddenHtml = generateVisualDigestHtml({ stats, range: 'week', scope: 'local', appVersion: '1.2.3', generatedAt: '2026-09-05 10:00', hideCosts: true });
    const hiddenSection = hiddenHtml.slice(hiddenHtml.indexOf('模型费用分布'));
    // 金额隐藏时改按有效 Token 降序：cheap-many-tokens（Token 最多）排最前。
    expect(hiddenSection.indexOf('cheap-many-tokens')).toBeLessThan(hiddenSection.indexOf('expensive-few-tokens'));
  });

  it('隐藏金额时全文没有任何"$数字"，防止排序、条形宽度以外的旁路泄漏（复核修复，强化 P3-6 覆盖）', () => {
    const html = generateVisualDigestHtml({
      stats: baseStats, range: 'week', scope: 'local', appVersion: '1.2.3', generatedAt: '2026-09-05 10:00', hideCosts: true,
    });
    expect(html.match(/\$[0-9]/g) ?? []).toHaveLength(0);
  });

  it('同期变化的纵深防御：非有限 percent 与未知 direction 一律省略，不输出 Infinity/NaN 或误判为下降（复核修复 P3-3）', () => {
    const malformedComparison = {
      window: {
        kind: 'weekOverWeek', timezone: 'UTC', bucket: 'day',
        currentStart: '2026-08-30', currentEnd: '2026-09-05',
        previousStart: '2026-08-23', previousEnd: '2026-08-29', alignedThrough: '2026-09-05',
      },
      current: { summary: baseStats.summary, series: [] },
      previous: { summary: baseStats.summary, series: [] },
      delta: {
        tokens: { absolute: 1, percent: Number.POSITIVE_INFINITY, direction: 'up' },
        requests: { absolute: 1, percent: Number.NaN, direction: 'down' },
        cost: { absolute: 1, percent: 12.3, direction: 'sideways' },
      },
    } as unknown as UsageComparison;
    const html = generateVisualDigestHtml({
      stats: { ...baseStats, comparison: malformedComparison },
      range: 'week', scope: 'local', appVersion: '1.2.3', generatedAt: '2026-09-05 10:00',
    });
    expect(html).not.toMatch(/Infinity/);
    expect(html).not.toMatch(/NaN/);
    expect(html).not.toMatch(/较上期 [+−]12\.3%/);
  });

  it('每日表纵深防御：status=recorded-estimate 但金额畸形（null/负数）时显示"不可得"，不落回"≈$0.00"（复核修复 P3-3）', () => {
    // 契约保证 recorded-estimate 的 amountUsd 严格为正有限数，这里刻意构造违反
    // 契约的畸形数据，验证离线导出不盲信调用点已经做过校验（P3-3 的"纵深防御"）。
    const malformedDailyCosts = {
      coverage: { start: '2026-08-30', end: '2026-09-05', timezone: 'UTC', state: 'complete' },
      days: [
        { date: '2026-09-01', amountUsd: null, status: 'recorded-estimate' },
        { date: '2026-09-02', amountUsd: -5, status: 'recorded-estimate' },
      ],
    } as unknown as StatsData['dailyCosts'];
    const html = generateVisualDigestHtml({
      stats: { ...baseStats, dailyCosts: malformedDailyCosts },
      range: 'week', scope: 'local', appVersion: '1.2.3', generatedAt: '2026-09-05 10:00',
    });
    const dailySection = html.slice(html.indexOf('每日预估费用'));
    expect(dailySection).not.toContain('≈$0.00');
    expect(dailySection).not.toContain('≈$-5.00');
    expect(dailySection.match(/不可得/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('工具排行表头改为"Token 占比"，避免紧邻的"预估费用"列被误读成费用占比（复核修复 P3-4）', () => {
    const html = report();
    const toolSection = html.slice(html.indexOf('工具消耗排行'), html.indexOf('模型费用分布'));
    expect(toolSection).toContain('<th scope="col" class="num">Token 占比</th>');
  });
});

describe('T10.253 离线简报交付边界', () => {
  const layouts = ['scorecard', 'journal', 'achievement', 'receipt', 'signal'] as const;
  const names = ['编辑宣言', 'AI 搭子', '流光档案', '月度通行证', '像素存档'];
  it.each(layouts)('%s 与海报风格同选且单文件无脚本/远端依赖', (layout) => {
    const html = generateVisualDigestHtml({ stats: baseStats, range: 'week', scope: 'local', appVersion: 'test', layout });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.body.dataset.layout).toBe(layout);
    expect(doc.body.textContent).toContain(names[layouts.indexOf(layout)]);
    expect(doc.querySelectorAll('script, link, iframe, object, embed, form, [src], [href], [onclick]')).toHaveLength(0);
    expect(html).not.toMatch(/url\(|@import|fetch\(|https?:\/\//);
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("default-src 'none'");
    expect(doc.body.textContent).toContain('1,200 Token · 输入 + 输出，不重复计入缓存');
    expect(doc.querySelectorAll('th:not([scope])')).toHaveLength(0);
  });

  it.each(layouts)('%s 隐藏费用后整个文件不含金额/排序泄漏或私有元数据', (layout) => {
    const stats = { ...baseStats, summary: { ...baseStats.summary, totalCost: 937.13 },
      tools: { safe: { ...baseStats.tools.codex, cost: 937.13 } },
      models: { lowToken: { ...baseStats.models.gpt, name: 'LowToken', input: 10, output: 0, cost: 900 },
        highToken: { ...baseStats.models.gpt, name: 'HighToken', cost: 37.13 } },
      history: [{ id: 'SESSION_PRIVATE_SENTINEL', content: 'PROMPT_PRIVATE_SENTINEL' }],
      meta: { email: 'EMAIL_PRIVATE_SENTINEL', deviceId: 'DEVICE_PRIVATE_SENTINEL', project: 'PROJECT_PRIVATE_SENTINEL' },
    } as unknown as StatsData;
    const html = generateVisualDigestHtml({ stats, range: 'week', scope: 'cloud', appVersion: 'test', layout, hideCosts: true });
    expect(html).not.toMatch(/937\.13|37\.13|≈\$|\$900|PRIVATE_SENTINEL/);
    expect(html.indexOf('HighToken')).toBeLessThan(html.indexOf('LowToken'));
    expect(html).toContain('费用已隐藏：费用、费用占比与费用变化均未写入文件。');
    expect(html).not.toContain('金额');
  });

  const monthStats: StatsData = {
    ...baseStats,
    meta: { generatedAt: '2026-09-30T10:00:00Z', timezone: 'UTC' },
    // 有真实汇总与热力图也不能代替趋势桶来推导星期节奏。
    heatmap: Object.fromEntries(Array.from({ length: 18 }, (_, index) => [`2026-09-${String(index + 1).padStart(2, '0')}`, 100])),
  };
  it.each(layouts)('%s 缺趋势且汇总非零时明确不可生成节奏，不伪造零值或峰值', (layout) => {
    for (const hideCosts of [false, true]) {
      const html = generateVisualDigestHtml({ stats: monthStats, range: 'month', scope: 'local', appVersion: 'test', layout, hideCosts });
      expect(html).toContain('星期节奏（日均）');
      expect(html).toContain('趋势明细未提供，无法生成星期节奏');
      expect(html).not.toMatch(/本期暂无消耗|日均消耗峰值|检出 \d+ 个突增|均未出现超过阈值/);
      expect(html).toContain('1,200 Token · 输入 + 输出，不重复计入缓存');
    }
  });
  it.each(layouts)('%s 真正全零且缺趋势时保留诚实空态', (layout) => {
    const stats = { ...monthStats, summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0, totalRequests: 0, avgTokensPerReq: 0 }, tools: {}, models: {}, heatmap: {} };
    const html = generateVisualDigestHtml({ stats, range: 'month', scope: 'local', appVersion: 'test', layout });
    expect(html).toContain('本期暂无消耗，色阶留空');
    expect(html).not.toContain('趋势明细未提供');
    expect(html).not.toMatch(/日均消耗峰值|检出 \d+ 个突增/);
  });
  it.each(layouts)('%s 有真实趋势时继续复用星期日均与突增规则', (layout) => {
    const stats = { ...monthStats, trends: Array.from({ length: 29 }, (_, index) => ({ date: `2026-09-${String(index + 1).padStart(2, '0')}`, codex: 100 })) };
    const html = generateVisualDigestHtml({ stats, range: 'month', scope: 'local', appVersion: 'test', layout });
    expect(html).toContain('按 29 个完整日聚合的日均消耗峰值');
    expect(html).toContain('已完成基线中的 29 个时段，均未出现超过阈值的单桶突增');
    expect(html).not.toMatch(/趋势明细未提供|本期暂无消耗/);
  });
  it('只有记录或缓存的非零汇总也不冒充全零，未知期间和年桶仍不生成节奏', () => {
    for (const summary of [
      { ...monthStats.summary, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 },
      { ...monthStats.summary, inputTokens: 0, outputTokens: 0, totalTokens: 0, totalRequests: 0 },
    ]) {
      expect(generateVisualDigestHtml({ stats: { ...monthStats, summary }, range: 'month', scope: 'local', appVersion: 'test' })).toContain('趋势明细未提供，无法生成星期节奏');
    }
    for (const [stats, range] of [[baseStats, 'all'], [monthStats, 'year']] as const) {
      const html = generateVisualDigestHtml({ stats, range, scope: 'cloud', appVersion: 'test' });
      expect(html).not.toContain('时段节奏与突增');
    }
  });

  it('自定义期间、来源时间与导出时间分开，不把导出时刻当来源', () => {
    const stats = { ...baseStats, meta: { generatedAt: '2026-09-29T03:00:00Z', timezone: 'Asia/Shanghai', stale: true,
      query: { range: 'custom', start: '2026-09-17', end: '2026-09-29' } } } as StatsData;
    const html = generateVisualDigestHtml({ stats, range: 'custom', scope: 'cloud', appVersion: 'test', generatedAt: '2026-10-02T17:00:00Z' });
    expect(html).toContain('2026-09-17 至 2026-09-29');
    expect(html).toContain('来源时间：2026-09-29T03:00:00Z');
    expect(html).toContain('导出时间：2026-10-02T17:00:00Z');
    expect(html).toContain('统计时区：Asia/Shanghai');
    expect(html).toContain('缓存快照');
    expect(report()).toContain('来源时间：来源未提供');
  });

  function comparison(): UsageComparison {
    return { window: { kind: 'weekOverWeek', timezone: 'UTC', bucket: 'day', currentStart: '2026-09-01', currentEnd: '2026-09-07', previousStart: '2026-08-25', previousEnd: '2026-08-31', alignedThrough: '2026-09-07' },
      current: { summary: baseStats.summary, series: [] }, previous: { summary: { ...baseStats.summary, totalCost: null as unknown as number }, series: [] },
      delta: { tokens: { absolute: 1, percent: 1, direction: 'up' }, requests: { absolute: 0, percent: 0, direction: 'flat' }, cost: { absolute: 0, percent: 0, direction: 'flat' } } };
  }
  it('同期费用未知不冒充持平，全年/全部不借用周环比', () => {
    const stats = { ...baseStats, comparison: comparison() };
    const doc = new DOMParser().parseFromString(report(stats), 'text/html');
    const cost = Array.from(doc.querySelectorAll('.kpi-card')).find(card => card.querySelector('.kpi-label')?.textContent === '预估费用');
    expect(cost?.textContent).toContain('费用不可比');
    expect(cost?.textContent).not.toContain('持平');
    for (const range of ['year', 'all'] as const) expect(generateVisualDigestHtml({ stats, range, scope: 'local', appVersion: 'test' })).not.toContain('较上期');
  });

  it('缓存三项直接来自契约，支持负净值；旧毛节省不冒充净值', () => {
    const stats = { ...baseStats, summary: { ...baseStats.summary, cacheSavings: { readSavedUsd: 1.25, writePremiumUsd: 2, netSavedUsd: -0.75, fallbackPricedReadTokens: 0, fallbackPricedWriteTokens: 0, priceBasis: 'local-prices' as const } } };
    const html = report(stats);
    expect(html).toContain('缓存读取节省 ≈$1.25');
    expect(html).toContain('缓存写入溢价 ≈$2.00');
    expect(html).toContain('缓存净节省 ≈−$0.75');
    expect(report()).toContain('缓存净节省不可得');
    const hidden = generateVisualDigestHtml({ stats, range: 'week', scope: 'local', appVersion: 'test', hideCosts: true });
    expect(hidden).not.toMatch(/≈\$|0\.75|1\.25/);
  });

  it('空数据诚实为0，畸形工具不画NaN占比，核心溢出拒绝导出', () => {
    const empty = { ...baseStats, summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0, totalRequests: 0, avgTokensPerReq: 0 }, tools: {}, models: {} };
    expect(report(empty)).toContain('暂无工具消耗记录');
    expect(report(empty)).toContain('暂无模型消耗记录');
    expect(report(empty)).not.toMatch(/NaN|Infinity/);
    const invalidTool = { ...baseStats, tools: { x: { ...baseStats.tools.codex, input: Number.NaN } } };
    expect(report(invalidTool)).not.toMatch(/NaN|Infinity/);
    expect(() => report({ ...baseStats, summary: { ...baseStats.summary, inputTokens: Number.MAX_VALUE, outputTokens: Number.MAX_VALUE } })).toThrow('Token 合计');
  });
});
