import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Summary, UsageComparison } from '../types';
import { placeCostHelp } from './CostHelpButton';
import { parseStatsDataContract } from '../utils/frontendContracts';
import { describeMetricChange, formatChangePercent, MetricsGrid, metricValueSizeClass } from './MetricsGrid';

function summary(cacheSavedUsd: unknown): Summary {
  return {
    totalTokens: 250,
    inputTokens: 200,
    outputTokens: 50,
    cachedTokens: 800,
    cacheReadTokens: 800,
    cacheWriteTokens: 0,
    cacheSavedUsd,
    totalCost: 1.2,
    totalRequests: 10,
    avgTokensPerReq: 25,
  } as Summary;
}

describe('MetricsGrid cache savings provenance', () => {
  it.each([null, Number.NaN, -1])('不把不可得节省金额 %s 显示为零', (value) => {
    const { unmount } = render(<MetricsGrid summary={summary(value)} showTotalTokens={false} />);
    expect(screen.getByText('缓存净节省不可得')).toBeInTheDocument();

    unmount();
  });

  it('保留有证据的真实零节省金额', () => {
    render(<MetricsGrid summary={{ ...summary(0), cacheSavings: { readSavedUsd: 0, writePremiumUsd: 0, netSavedUsd: 0, fallbackPricedReadTokens: 0, fallbackPricedWriteTokens: 0, priceBasis: 'local-prices' } }} showTotalTokens={false} />);
    expect(screen.getByText(/缓存净节省 ≈\$0\.00/)).toBeInTheDocument();
  });

  it('缓存只有合计时不报告命中率；请求卡不再给第二种日均（T10.159 P3-1）', () => {
    const combined = { ...summary(0), cacheReadTokens: undefined, cacheWriteTokens: undefined };
    render(<MetricsGrid summary={combined} showTotalTokens={false} />);
    expect(screen.getByText(/当前数据仅提供缓存合计/)).toBeInTheDocument();
    expect(screen.queryByText(/命中率/)).not.toBeInTheDocument();
    // 总览只有趋势卡那一种“按已完成的日子”计算的日均；请求卡只留每条均耗。
    expect(screen.getByText('每条均耗 25')).toBeInTheDocument();
    expect(screen.queryByText(/日均/)).not.toBeInTheDocument();
  });
});

describe('MetricsGrid 预估费用卡（T10.154 A1：D01–D03）', () => {
  it('标签旁有 ⓘ，可得时不再铺短注（U-102，说明在 ⓘ 里）', () => {
    render(<MetricsGrid summary={summary(0)} showTotalTokens={false} />);
    const card = screen.getByText('预估费用').closest('.metric-card') as HTMLElement;
    expect(card).toHaveTextContent('≈$1.20');
    expect(card.querySelector('.metric-sub')).toBeNull();
    expect(card).not.toHaveTextContent('按价格表估算，非账单');
    expect(card).not.toHaveTextContent(/缓存读|缓存 \d/);
    expect(screen.getByRole('button', { name: '预估费用说明' })).toHaveAttribute('aria-expanded', 'false');
  });

  it.each([Number.NaN, Infinity, -1])('总额 %s 不可证明时写「不可得」与原因，不画 $0，也不给同期变化', (totalCost) => {
    render(<MetricsGrid summary={{ ...summary(0), totalCost }} showTotalTokens={false} scope="local" comparison={comparison()} />);
    const card = screen.getByText('预估费用').closest('.metric-card') as HTMLElement;
    expect(card.querySelector('.metric-value')).toHaveTextContent(/^不可得$/);
    expect(card.querySelector('.metric-sub')).toHaveTextContent('来源未提供可验证的费用');
    expect(card.querySelector('.metric-change')).toBeNull();
    expect(card).not.toHaveTextContent(/\$0|NaN|Infinity/);
  });

  it('帮助弹层：点按打开非模态说明，Escape 关闭并把焦点还给按钮，不冒泡关掉外层弹窗', () => {
    const outerEscape = vi.fn();
    document.addEventListener('keydown', outerEscape);
    try {
      render(<MetricsGrid summary={summary(0)} showTotalTokens={false} />);
      const button = screen.getByRole('button', { name: '预估费用说明' });
      fireEvent.click(button);
      expect(button).toHaveAttribute('aria-expanded', 'true');
      const popover = screen.getByRole('dialog', { name: '预估费用说明' });
      expect(button).toHaveAttribute('aria-controls', popover.id);
      expect(popover).toHaveTextContent('预估费用：按模型价格表估算；工具日志自带费用时直接采用。都不是供应商账单，实际以账单为准。调价前的记录仍按当时的价格估算；GPT、Gemini、Grok 等长上下文加价按请求长度计入，批处理与渠道加价未计入。');
      expect(popover).not.toHaveAttribute('aria-modal');
      expect(popover).toHaveFocus();

      fireEvent.keyDown(popover, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: '预估费用说明' })).not.toBeInTheDocument();
      expect(button).toHaveFocus();
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(outerEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', outerEscape);
    }
  });

  it('帮助弹层：点弹层外关闭；Tab 离开时关闭并把焦点交回按钮', () => {
    render(<MetricsGrid summary={summary(0)} showTotalTokens={false} />);
    const button = screen.getByRole('button', { name: '预估费用说明' });
    fireEvent.click(button);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: '预估费用说明' })).not.toBeInTheDocument();

    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole('dialog', { name: '预估费用说明' }), { key: 'Tab' });
    expect(screen.queryByRole('dialog', { name: '预估费用说明' })).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('在对话框里打开时弹层挂在对话框内，读屏不会因 aria-modal 读不到', () => {
    render(<div role="dialog" aria-modal="true" aria-label="专属看板"><MetricsGrid summary={summary(0)} showTotalTokens={false} /></div>);
    fireEvent.click(screen.getByRole('button', { name: '预估费用说明' }));
    const popover = screen.getByRole('dialog', { name: '预估费用说明' });
    expect(popover.parentElement).toBe(screen.getByRole('dialog', { name: '专属看板' }));
  });

  it('弹层定位：默认在按钮下方并夹在视口内，下方放不下时翻到上方', () => {
    expect(placeCostHelp({ left: 100, top: 40, bottom: 58 }, 320, 90, 1200, 800)).toEqual({ left: 88, top: 66 });
    expect(placeCostHelp({ left: 1150, top: 40, bottom: 58 }, 320, 90, 1200, 800)).toEqual({ left: 872, top: 66 });
    expect(placeCostHelp({ left: 100, top: 760, bottom: 778 }, 320, 90, 1200, 800)).toEqual({ left: 88, top: 662 });
  });

  it('MetricsGrid 把 scope 传给帮助按钮：云端范围弹层多一句零值合计提示，本机范围不出现（T10.197 评审 P3-2）', () => {
    const { unmount } = render(<MetricsGrid summary={summary(0)} showTotalTokens={false} scope="local" />);
    fireEvent.click(screen.getByRole('button', { name: '预估费用说明' }));
    expect(screen.getByRole('dialog', { name: '预估费用说明' })).not.toHaveTextContent('按 0 计入');
    unmount();

    render(<MetricsGrid summary={summary(0)} showTotalTokens={false} scope="cloud" />);
    fireEvent.click(screen.getByRole('button', { name: '预估费用说明' }));
    expect(screen.getByRole('dialog', { name: '预估费用说明' })).toHaveTextContent('云端汇总把没有费用的记录按 0 计入。');
  });
});

describe('MetricsGrid KPI never wraps', () => {
  it('按最终字符串长度降字号而不是换行', () => {
    expect(metricValueSizeClass('≈$3.21')).toBe('');
    expect(metricValueSizeClass('1.23M')).toBe('');
    expect(metricValueSizeClass('≈$1,422.78')).toBe(' is-long');
    expect(metricValueSizeClass('≈$12,345.67')).toBe(' is-longer');
    expect(metricValueSizeClass('≈$123,456.78')).toBe(' is-longer');
    expect(metricValueSizeClass('≈$1,234,567.89')).toBe(' is-longest');
  });

  it('长金额的成本卡带上降级类，其它卡不受影响', () => {
    render(<MetricsGrid summary={{ ...summary(0), totalCost: 1422.78 }} showTotalTokens={false} />);
    const values = document.querySelectorAll('.metric-value');
    expect(values).toHaveLength(4);
    expect(values[1]).toHaveClass('is-long');
    expect(values[1].closest('.metric-card')).toHaveClass('has-compact-value');
    expect(values[0]).not.toHaveClass('is-long');
  });
});

function comparison(overrides: {
  kind?: UsageComparison['window']['kind'];
  previous?: Partial<Summary>;
  current?: Partial<Summary>;
  delta?: Partial<UsageComparison['delta']>;
} = {}): UsageComparison {
  const base = summary(0);
  return {
    window: {
      kind: overrides.kind ?? 'weekOverWeek',
      timezone: 'Asia/Shanghai',
      bucket: 'day',
      currentStart: '2026-09-21T00:00:00+08:00',
      currentEnd: '2026-09-24T14:00:00+08:00',
      previousStart: '2026-09-14T00:00:00+08:00',
      previousEnd: '2026-09-17T14:00:00+08:00',
      alignedThrough: '2026-09-24 14:00',
    },
    current: { summary: { ...base, ...overrides.current }, series: [] },
    previous: { summary: { ...base, totalTokens: 200, totalRequests: 8, ...overrides.previous }, series: [] },
    delta: {
      tokens: { absolute: 1_200_000, percent: 12.46, direction: 'up' },
      requests: { absolute: -3, percent: -4.2, direction: 'down' },
      cost: { absolute: 3.2, percent: 250, direction: 'up' },
      ...overrides.delta,
    },
  };
}

/** 变化行的可见文字（读屏句子单独放在 sr-only 里）。 */
function changeLines(): string[] {
  return [...document.querySelectorAll('.metric-change')].map((node) => (
    [...node.querySelectorAll('[aria-hidden="true"]')].map((part) => part.textContent ?? '').join(' ')
  ));
}

describe('MetricsGrid 同期变化（T10.159，审计 Q3）', () => {
  it('没有 comparison 时不画变化行，也不写 0%', () => {
    render(<MetricsGrid summary={summary(0)} showTotalTokens={false} scope="local" />);
    expect(document.querySelectorAll('.metric-change')).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/(^|[^\d.])0%|∞/);
  });

  it('有效 Token、预估费用与记录数显示中性的百分比与绝对变化', () => {
    render(<MetricsGrid summary={summary(0)} showTotalTokens={false} scope="local" comparison={comparison()} />);
    const lines = changeLines();
    expect(lines[0]).toContain('+12%');
    expect(lines[0]).toContain('· +1.20M');
    // U-102：未截短时比较窗口不逐卡铺开，只在 title 与读屏句里。
    expect(lines[0]).not.toContain('较上周同期');
    expect(lines[1]).toContain('+250%');
    expect(lines[1]).toContain('· +$3.20');
    expect(lines[2]).toContain('−4.2%');
    expect(lines[2]).toContain('· −3');
    expect(screen.getByTitle('有效 Token较上周同期增加 12%，绝对变化 +1.20M')).toBeInTheDocument();
    expect(screen.getByText('记录数较上周同期减少 4.2%，绝对变化 −3')).toHaveClass('sr-only');
    expect(screen.getByText('预估费用')).toHaveClass('metric-label');
    // 中性色：不借语义色表达好坏。
    for (const line of document.querySelectorAll('.metric-change')) {
      expect(line.className).not.toMatch(/text-(warning|danger|success)/);
    }
  });

  it('上期为 0 时写“新增”或“持平”，从不写 0% 或 ∞', () => {
    render(<MetricsGrid summary={summary(0)} showTotalTokens={false} scope="local" comparison={comparison({
      previous: { totalTokens: 0, totalRequests: 0, totalCost: 0, cachedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      delta: {
        tokens: { absolute: 250, percent: null, direction: 'new' },
        requests: { absolute: 10, percent: null, direction: 'new' },
        cost: { absolute: 0, percent: null, direction: 'flat' },
      },
    })} />);
    const lines = changeLines();
    expect(lines[0]).toContain('新增');
    expect(lines[0]).toContain('+250');
    expect(lines[1]).toContain('持平');
    expect(lines[3]).toContain('新增');
    expect(lines.join(' ')).not.toMatch(/%|∞|Infinity|NaN/);
  });

  it('云端上期记录与 Token 均为 0 时写“基线缺失”，不计算变化', () => {
    render(<MetricsGrid summary={summary(0)} showTotalTokens={false} scope="cloud" comparison={comparison({
      previous: { totalTokens: 0, totalRequests: 0, totalCost: 0 },
      delta: {
        tokens: { absolute: 250, percent: null, direction: 'new' },
        requests: { absolute: 10, percent: null, direction: 'new' },
        cost: { absolute: 1.2, percent: null, direction: 'new' },
      },
    })} />);
    expect(screen.getAllByText('基线缺失')).toHaveLength(3);
    expect(changeLines()).toHaveLength(3);
    expect(changeLines().join(' ')).not.toMatch(/新增|%/);
  });

  it('不知道作用域且上期为空时无法证明基线，不显示变化', () => {
    render(<MetricsGrid summary={summary(0)} showTotalTokens={false} comparison={comparison({
      previous: { totalTokens: 0, totalRequests: 0 },
      delta: { tokens: { absolute: 250, percent: null, direction: 'new' } },
    })} />);
    expect(changeLines()).toHaveLength(0);
  });

  it('含缓存口径下主值是总 Token，变化标签写明是有效 Token 的变化', () => {
    render(<MetricsGrid summary={summary(0)} showTotalTokens scope="local" comparison={comparison()} />);
    expect(changeLines()[0]).toMatch(/^有效 \+12%/);
  });

  it('缓存变化只在本机、且两期缓存口径与卡片一致时显示', () => {
    const local = render(<MetricsGrid summary={summary(0)} showTotalTokens={false} scope="local" comparison={comparison({
      current: { cachedTokens: 800, cacheReadTokens: 800, cacheWriteTokens: 0 },
      previous: { cachedTokens: 500, cacheReadTokens: 400, cacheWriteTokens: 100 },
    })} />);
    expect(changeLines()[3]).toContain('+100%');
    expect(changeLines()[3]).toContain('· +400');
    local.unmount();

    const cloud = render(<MetricsGrid summary={summary(0)} showTotalTokens={false} scope="cloud" comparison={comparison()} />);
    expect(changeLines()).toHaveLength(3);
    cloud.unmount();

    render(<MetricsGrid summary={summary(0)} showTotalTokens={false} scope="local" comparison={comparison({
      previous: { cachedTokens: 500, cacheReadTokens: undefined, cacheWriteTokens: undefined },
    })} />);
    expect(changeLines()).toHaveLength(3);
  });

  it('月末同期截短时变化写明“截至 {对齐日}”，读屏句同样带上；平日不写（T10.159 P2-2）', () => {
    const base = comparison({ kind: 'monthOverMonth' });
    // 3/31 14:00 生成：主值统计到现在，同期对比被对齐到 2/28，本期窗口止于 3/28 14:00。
    const march: UsageComparison = { ...base, window: { ...base.window, currentEnd: '2026-03-28T14:00:00+08:00' } };
    const meta = (generatedAt: string) => ({
      generatedAt,
      timezone: 'Asia/Shanghai',
      query: {
        range: 'month' as const,
        timezone: 'Asia/Shanghai',
        machines: [],
        tools: [],
        models: [],
        search: null,
        tokenMode: 'effective' as const,
      },
    });
    const view = render(<MetricsGrid summary={summary(0)} showTotalTokens={false} scope="local" comparison={march}
      meta={meta('2026-03-31T14:00:00+08:00')} range="month" />);
    const lines = changeLines();
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line).toContain('较上月同期（截至 3月28日）');
    expect(screen.getByText('有效 Token较上月同期（截至 3月28日）增加 12%，绝对变化 +1.20M')).toHaveClass('sr-only');

    // 对比截止与生成在同一天：两者是同一个窗口，不写说明。
    view.rerender(<MetricsGrid summary={summary(0)} showTotalTokens={false} scope="local" comparison={march}
      meta={meta('2026-03-28T14:00:00+08:00')} range="month" />);
    expect(changeLines()[0]).not.toContain('较上月同期');
    expect(changeLines().join(' ')).not.toContain('截至');
  });

  it('百分比格式：≥10 取整，<10 保留一位，负号用 U+2212；小于 0.05% 视为持平', () => {
    expect(formatChangePercent(18.4)).toBe('+18%');
    expect(formatChangePercent(-8)).toBe('−8.0%');
    expect(formatChangePercent(0.3)).toBe('+0.3%');
    expect(describeMetricChange({ absolute: 1, percent: 0.01, direction: 'up' }, String, '较上月同期', '记录数'))
      .toMatchObject({ headline: '持平', absolute: null });
  });
});

describe('MetricsGrid 卡片身份稳定（T10.159 F8）', () => {
  it('切换“含缓存”口径或缓存口径时更新原卡片，不重建、不重播入场动画', () => {
    const view = render(<MetricsGrid summary={summary(0)} showTotalTokens={false} scope="local" comparison={comparison()} />);
    const before = [...document.querySelectorAll('.metric-card')];
    expect(before).toHaveLength(4);
    expect(before[0]).toHaveTextContent('有效 Token');
    expect(before[3]).toHaveTextContent('缓存读取');

    view.rerender(<MetricsGrid summary={summary(0)} showTotalTokens scope="local" comparison={comparison()} />);
    const afterTotal = [...document.querySelectorAll('.metric-card')];
    expect(afterTotal[0]).toHaveTextContent('总 Tokens');
    afterTotal.forEach((card, index) => expect(card).toBe(before[index]));

    // 缓存只剩合计时标签从“缓存读取”变成“缓存”，卡片仍是同一个元素。
    const combined = { ...summary(0), cacheReadTokens: undefined, cacheWriteTokens: undefined } as Summary;
    view.rerender(<MetricsGrid summary={combined} showTotalTokens scope="local" comparison={comparison()} />);
    const afterCache = [...document.querySelectorAll('.metric-card')];
    expect(afterCache[3]).toHaveTextContent('缓存');
    expect(afterCache[3]).not.toHaveTextContent('缓存读取');
    afterCache.forEach((card, index) => expect(card).toBe(before[index]));
  });
});

describe('T10.252 同期费用不可得的呈现保护', () => {
  it('精确原生IPC字段：本期20.279999999999976、同期null、down/null差值，不得写持平或下降', () => {
    const current = { ...summary(0), totalCost: 20.279999999999976 };
    const nativeComparison = {
      ...comparison({ kind: 'periodOverPeriod' }),
      window: {
        kind: 'periodOverPeriod', timezone: 'Asia/Shanghai', bucket: 'day',
        currentStart: '2026-09-17T00:00:00+08:00', currentEnd: '2026-09-29T23:59:59+08:00',
        previousStart: '2026-09-04T00:00:00+08:00', previousEnd: '2026-09-16T23:59:59+08:00',
        alignedThrough: '2026-09-29 23:59',
      },
      current: { summary: current, series: [] },
      previous: { summary: { ...summary(0), totalCost: null }, series: [] },
      delta: { ...comparison().delta, cost: { absolute: null, percent: null, direction: 'down' } },
    };
    // Match the affected native wire fields; unrelated metrics use the existing
    // anonymous fixture. Run the actual parser so null is not pre-coerced.
    const wire = { summary: current, comparison: nativeComparison,
      tools: {}, models: {}, trends: [], heatmap: {}, history: [],
      meta: { capabilities: { comparison: true }, timezone: 'Asia/Shanghai',
        generatedAt: '2026-10-02T15:00:00+08:00', query: {
          range: 'custom', start: '2026-09-17', end: '2026-09-29', timezone: 'Asia/Shanghai',
          machines: [], tools: [], models: [], search: null, tokenMode: 'effective',
        } },
    };
    const parsed = parseStatsDataContract(wire);
    expect(parsed.comparison?.previous.summary.totalCost).toBeNull();
    expect(parsed.comparison?.delta.cost).toEqual({ absolute: null, percent: null, direction: 'down' });
    // This presentation fix must not relax required current-summary validation.
    expect(() => parseStatsDataContract({ ...wire, summary: { ...current, totalCost: null } }))
      .toThrow('summary.totalCost 无效');
    render(<MetricsGrid summary={parsed.summary} showTotalTokens={false} scope="local" range="custom"
      comparison={parsed.comparison} meta={parsed.meta} />);
    const card = screen.getByText('预估费用').closest('.metric-card') as HTMLElement;
    expect(card.querySelector('.metric-value')).toHaveTextContent('≈$20.28');
    expect(card.querySelector('.metric-change')).toHaveTextContent('不可比');
    expect(card.querySelector('.metric-change')).toHaveTextContent('同期费用不可得');
    expect(card.querySelector('.metric-change')).not.toHaveTextContent(/持平|下降|减少|新增|%/);
    expect(card.querySelector('.metric-change svg')).toBeNull();
    expect(changeLines()[0]).toContain('+12%');
    expect(changeLines()[2]).toContain('−4.2%');
  });

  it('未知direction即使附带有限差值也不能编造方向', () => {
    const unrecognized = { absolute: 1, percent: null, direction: 'unknown' } as unknown as UsageComparison['delta']['cost'];
    expect(describeMetricChange(unrecognized, String, '较上期', '预估费用'))
      .toMatchObject({ headline: '不可比', direction: null, absolute: null });
  });

  it('百分比缺失而有限负差值已知时仍可显示绝对下降', () => {
    expect(describeMetricChange({ absolute: -3.2, percent: null, direction: 'down' }, String, '较上期', '预估费用'))
      .toMatchObject({ headline: '−3.2', direction: 'down' });
  });

  it.each([null, undefined, Number.NaN, Infinity])('无效absolute=%s不在formatter中补成零', (absolute) => {
    expect(describeMetricChange({ absolute: absolute as number, percent: null, direction: 'down' }, String, '较上期', '预估费用'))
      .toMatchObject({ headline: '不可比', direction: null, absolute: null });
  });

  it.each([null, undefined, Number.NaN, Infinity, -1])('同期费用%s未知时不信任数值差值占位', (totalCost) => {
    render(<MetricsGrid summary={summary(0)} showTotalTokens={false} scope="local"
      comparison={comparison({ previous: { totalCost: totalCost as number },
        delta: { cost: { absolute: 0, percent: 0, direction: 'flat' } } })} />);
    const card = screen.getByText('预估费用').closest('.metric-card') as HTMLElement;
    expect(card.querySelector('.metric-change')).toHaveTextContent('不可比');
    expect(card.querySelector('.metric-change')).not.toHaveTextContent(/持平|%/);
  });

  it('顶层金额已知而同期对齐窗口的本期费用未知时，不从主值重算', () => {
    render(<MetricsGrid summary={summary(0)} showTotalTokens={false} scope="local"
      comparison={comparison({ current: { totalCost: Number.NaN } })} />);
    const card = screen.getByText('预估费用').closest('.metric-card') as HTMLElement;
    expect(card.querySelector('.metric-value')).toHaveTextContent('≈$1.20');
    expect(card.querySelector('.metric-change')).toHaveTextContent('不可比');
  });

  it.each([
    { current: 0, previous: 0, absolute: 0, percent: null, direction: 'flat', headline: '持平' },
    { current: 3.2, previous: 0, absolute: 3.2, percent: null, direction: 'new', headline: '新增' },
    { current: 0, previous: 3.2, absolute: -3.2, percent: -100, direction: 'down', headline: '−100%' },
  ] as const)('已知费用$current/$previous保留$headline（percent:null不一概当未知）', ({ current, previous, absolute, percent, direction, headline }) => {
    render(<MetricsGrid summary={{ ...summary(0), totalCost: current }} showTotalTokens={false} scope="local"
      comparison={comparison({ current: { totalCost: current }, previous: { totalCost: previous }, delta: { cost: { absolute, percent, direction } } })} />);
    const card = screen.getByText('预估费用').closest('.metric-card') as HTMLElement;
    expect(card.querySelector('.metric-change')).toHaveTextContent(headline);
    expect(card).not.toHaveTextContent('不可比');
  });
});
