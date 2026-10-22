import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityDashboard, StatsQueryContext } from '../types';
import { EntityDashboardModal } from './EntityDashboardModal';

vi.mock('./MetricsGrid', () => ({ MetricsGrid: () => <div>metrics</div> }));
vi.mock('./TrendPanel', () => ({ TrendPanel: () => <div>trend</div> }));
vi.mock('./YearHeatmap', () => ({ YearHeatmap: () => <div>heatmap</div> }));

const SUMMARY = {
  totalTokens: 120,
  inputTokens: 100,
  outputTokens: 20,
  cachedTokens: 30,
  totalCost: 1,
  totalRequests: 2,
  avgTokensPerReq: 60,
};

const DATA: EntityDashboard = {
  status: 'ok',
  entity: { kind: 'model', model: 'gpt-5-codex' },
  summary: SUMMARY,
  comparison: null,
  composition: { tools: [], models: [], machines: [] },
  heatmap: {},
  peak: {},
  activity: { activeDays: 1, firstSeenAt: null, lastSeenAt: null },
  historyPage: {
    status: 'ok',
    items: [],
    nextCursor: null,
    hasMore: false,
    totalCount: 0,
    filteredSummary: SUMMARY,
    availableFilters: { tools: [], models: [], machines: [] },
    granularity: 'request',
  },
  granularity: 'request',
};

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

function renderModal(customData: EntityDashboard = DATA) {
  return render(
    <EntityDashboardModal
      selection={{ kind: 'model', name: 'gpt-5-codex' }}
      range="today"
      scope="local"
      data={customData}
      loading={false}
      error=""
      onClose={vi.fn()}
      onRetry={vi.fn()}
      onOpenDetails={vi.fn()}
      onOpenEntity={vi.fn()}
    />,
  );
}

describe('EntityDashboardModal model ID copy action', () => {
  it('实体看板最近明细沿用聚合日志粒度', () => {
    const aggregateData: EntityDashboard = {
      ...DATA,
      historyPage: {
        ...DATA.historyPage,
        items: [{
          id: 1,
          tool: 'codex',
          model: 'gpt-5-codex',
          inputTokens: 210800,
          outputTokens: 147000,
          cachedTokens: 68280,
          cost: 5.95,
          timestamp: '2026-07-15T06:05:00.000Z',
          sessionId: 'session-1',
          machineId: 'Studio-PC',
          requests: 738,
          granularity: 'request',
        }],
        totalCount: 1,
        filteredSummary: { ...SUMMARY, totalRequests: 738 },
      },
    };

    renderModal(aggregateData);

    expect(screen.getByText(/统计周期：今日 · .*日志聚合/)).toBeInTheDocument();
    expect(screen.getByText('日志聚合')).toBeInTheDocument();
  });

  it('剪贴板不可用时给出明确失败状态和完整手动复制入口', async () => {
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: '复制模型 ID' }));

    await waitFor(() => expect(screen.getByRole('button', { name: '复制失败，点击重试模型 ID' })).toBeInTheDocument());
    expect(screen.getByText('剪贴板不可用')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '模型 ID（手动复制）' })).toHaveValue('gpt-5-codex');
  });

  it('复制成功时显示短暂的成功状态并写入完整模型 ID', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: '复制模型 ID' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('gpt-5-codex'));
    expect(screen.getByRole('button', { name: '已复制模型 ID' })).toBeInTheDocument();
    expect(screen.queryByText('剪贴板不可用')).not.toBeInTheDocument();
  });

  it('复制进行中显示忙碌语义并阻止重复点击', async () => {
    let resolveWriteText: (() => void) | undefined;
    const writeText = vi.fn(() => new Promise<void>((resolve) => {
      resolveWriteText = resolve;
    }));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: '复制模型 ID' }));
    const copying = screen.getByRole('button', { name: '正在复制模型 ID' });
    expect(copying).toBeDisabled();
    expect(copying).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(copying);
    expect(writeText).toHaveBeenCalledTimes(1);

    resolveWriteText?.();
    await waitFor(() => expect(screen.getByRole('button', { name: '已复制模型 ID' })).toBeInTheDocument());
  });

  it('实体看板失败恢复入口在重试期间显示进行中反馈并阻止重复点击', () => {
    const onRetry = vi.fn();
    const view = render(
      <EntityDashboardModal
        selection={{ kind: 'model', name: 'gpt-5-codex' }}
        range="today"
        scope="local"
        data={DATA}
        loading={false}
        error="读取实体看板失败"
        onClose={vi.fn()}
        onRetry={onRetry}
        onOpenDetails={vi.fn()}
        onOpenEntity={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    view.rerender(
      <EntityDashboardModal
        selection={{ kind: 'model', name: 'gpt-5-codex' }}
        range="today"
        scope="local"
        data={DATA}
        loading
        error="读取实体看板失败"
        onClose={vi.fn()}
        onRetry={onRetry}
        onOpenDetails={vi.fn()}
        onOpenEntity={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '重新加载中…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '重新加载中…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(screen.getByRole('button', { name: '重新加载中…' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('分布卡片可在有效 Token 与费用之间切换对比口径，最近明细同时给出预估费用（T10.154 D40–D41）', () => {
    const toolData: EntityDashboard = {
      ...DATA,
      entity: { kind: 'tool', tool: 'claude' },
      composition: {
        tools: [],
        models: [
          { value: 'model-a', tokens: 1000, requests: 5, cost: 0.1 },
          { value: 'model-b', tokens: 400, requests: 2, cost: 0.5 },
        ],
        machines: [],
      },
      historyPage: {
        ...DATA.historyPage,
        items: [{
          id: 1, tool: 'claude', model: 'model-a', inputTokens: 600, outputTokens: 400, cachedTokens: 0, cost: 0.25,
          timestamp: '2026-09-05T11:04:00Z', sessionId: 's1', machineId: 'HZ-130-9',
        }],
        totalCount: 1,
      },
    };
    render(
      <EntityDashboardModal
        selection={{ kind: 'tool', name: 'claude' }}
        range="today"
        scope="local"
        data={toolData}
        loading={false}
        error=""
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={vi.fn()}
      />,
    );

    const card = screen.getByText('关联模型分布').closest('section') as HTMLElement;
    let rows = within(card).getAllByRole('button');
    expect(rows[0]).toHaveTextContent('model-a');
    expect(rows[0]).toHaveTextContent('1.0K（71%） · 5 次 · ≈$0.10');
    expect(card).toHaveAttribute('data-metric', 'tokens');

    fireEvent.click(screen.getByRole('button', { name: '费用' }));
    expect(screen.getByRole('button', { name: '费用' })).toHaveAttribute('aria-pressed', 'true');
    rows = within(card).getAllByRole('button');
    expect(rows[0]).toHaveTextContent('model-b');
    expect(rows[0]).toHaveTextContent('≈$0.50（83%） · 400 · 2 次');
    expect(card).toHaveAttribute('data-metric', 'cost');

    // 最近明细是单条记录：不足 $1 保留 4 位（§4.1）。
    expect(screen.getByText(/≈\$0\.2500 · /)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '金额' })).not.toBeInTheDocument();
  });

  it('不可得的费用排在真实零后面，二者均不绘制虚假最小数据条', () => {
    const data: EntityDashboard = {
      ...DATA,
      composition: { models: [], machines: [], tools: [
        { value: 'unknown', tokens: 100, requests: 1, cost: Number.NaN },
        { value: 'zero', tokens: 50, requests: 1, cost: 0 },
        { value: 'paid', tokens: 50, requests: 1, cost: 2 },
      ] },
    };
    renderModal(data);
    fireEvent.click(screen.getByRole('button', { name: '费用' }));
    const card = screen.getByText('关联工具分布').closest('section')!;
    const rows = within(card).getAllByRole('button');
    expect(rows[0]).toHaveTextContent('Paid');
    expect(rows[1]).toHaveTextContent('Zero');
    expect(rows[1]).toHaveTextContent('≈$0.00');
    // T10.154 D41–D42：未知写「不可得」，说明换成统一叫法。工具 id 用显示名（TOKE-12）。
    expect(rows[2]).toHaveTextContent(/^Unknown不可得 · 100 · 1 次$/);
    expect(rows[2]).not.toHaveTextContent('≈$0.00');
    expect(rows[1].querySelector('.entity-composition-bar span')).toHaveStyle({ width: '0%' });
    expect(rows[2].querySelector('.entity-composition-bar span')).toHaveStyle({ width: '0%' });
    expect(card).toHaveTextContent('占比只按已知费用计算；不可得的项保留在列表中。');
    expect(card).not.toHaveTextContent(/金额/);
  });

  it('支持在模态框内多级跳转、展示面包屑与返回上级看板', () => {
    const onOpenEntity = vi.fn();
    const toolData: EntityDashboard = {
      ...DATA,
      entity: { kind: 'tool', tool: 'claude' },
      composition: {
        tools: [],
        models: [{ value: 'claude-3-5-sonnet', tokens: 1000, requests: 5, cost: 0.1 }],
        machines: [],
      },
    };

    const view = render(
      <EntityDashboardModal
        selection={{ kind: 'tool', name: 'claude' }}
        range="today"
        scope="local"
        data={toolData}
        loading={false}
        error=""
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={onOpenEntity}
      />,
    );

    // Initial state: no breadcrumb or back button
    expect(screen.queryByRole('button', { name: '返回上一个看板' })).not.toBeInTheDocument();

    // Click on model in composition list
    const modelRow = screen.getByRole('button', { name: /claude-3-5-sonnet/ });
    fireEvent.click(modelRow);

    expect(onOpenEntity).toHaveBeenCalledWith('model', 'claude-3-5-sonnet', 'claude');

    // Rerender with next selection (navigated to model)
    const modelData: EntityDashboard = {
      ...DATA,
      entity: { kind: 'model', model: 'claude-3-5-sonnet' },
      composition: {
        tools: [{ value: 'claude', tokens: 1000, requests: 5, cost: 0.1 }],
        models: [],
        machines: [],
      },
    };

    view.rerender(
      <EntityDashboardModal
        selection={{ kind: 'model', name: 'claude-3-5-sonnet', tool: 'claude' }}
        range="today"
        scope="local"
        data={modelData}
        loading={false}
        error=""
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={onOpenEntity}
      />,
    );

    // Now back button and breadcrumb are visible
    const backBtn = screen.getByRole('button', { name: '返回上一个看板' });
    expect(backBtn).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '专属看板导航历史' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回 Claude' })).toBeInTheDocument();

    // Click back button to pop
    fireEvent.click(backBtn);
    expect(onOpenEntity).toHaveBeenCalledWith('tool', 'claude', undefined);
  });
});

const MATCHING_QUERY: StatsQueryContext = {
  range: 'today', timezone: 'UTC', machines: [], tools: [], models: [], search: null, tokenMode: 'effective',
};

// 复核修复 R2-2：entity 与全局两侧都"同一时刻抓取"的基准时间戳，用于占比
// 可比较的正向用例；下面几个新鲜度测试在此基础上制造缺失/超阈值/跨日差异。
const MATCHING_GENERATED_AT = '2026-09-24T10:00:00.000Z';

describe('Q10：占总预估费用与单位费用（T10.163）', () => {
  it('单位费用按有效 Token（输入 + 输出）计算，公式为 预估费用 ÷ 有效 Token × 1,000,000', () => {
    const data: EntityDashboard = {
      ...DATA,
      summary: { ...SUMMARY, totalCost: 12, inputTokens: 3_000_000, outputTokens: 3_000_000 },
    };
    renderModal(data);
    expect(screen.getByText('单位费用').closest('div')).toHaveTextContent('单位费用≈$2.00/百万 Token');
  });

  it('有效 Token 为 0 时单位费用显示"不可得"，不显示 0 或 Infinity', () => {
    const zeroTokens: EntityDashboard = {
      ...DATA,
      summary: { ...SUMMARY, totalCost: 12, inputTokens: 0, outputTokens: 0 },
    };
    renderModal(zeroTokens);
    expect(screen.getByText('单位费用').closest('div')).toHaveTextContent('单位费用不可得');
  });

  it('费用非有限（NaN）时单位费用显示"不可得"，不假装成 0', () => {
    const badCost: EntityDashboard = {
      ...DATA,
      summary: { ...SUMMARY, totalCost: Number.NaN },
    };
    renderModal(badCost);
    expect(screen.getByText('单位费用').closest('div')).toHaveTextContent('单位费用不可得');
  });

  it('未提供 globalCostContext 时"占总预估费用"整项隐藏，不假定分母', () => {
    renderModal();
    expect(screen.queryByText('占总预估费用')).not.toBeInTheDocument();
  });

  it('globalCostContext 与实体查询同一 range/scope/筛选、新鲜度也一致时，按同一份总额计算占比', () => {
    const data: EntityDashboard = {
      ...DATA,
      summary: { ...SUMMARY, totalCost: 25 },
      meta: { query: MATCHING_QUERY, generatedAt: MATCHING_GENERATED_AT },
    };
    render(
      <EntityDashboardModal
        selection={{ kind: 'model', name: 'gpt-5-codex' }}
        range="today"
        scope="local"
        data={data}
        loading={false}
        error=""
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={vi.fn()}
        globalCostContext={{ totalCost: 100, query: MATCHING_QUERY, scope: 'local', generatedAt: MATCHING_GENERATED_AT }}
      />,
    );
    expect(screen.getByText('占总预估费用').closest('div')).toHaveTextContent('占总预估费用25%');
  });

  it('globalCostContext 的 scope 与看板不一致时隐藏整项，不跨作用域拼百分比', () => {
    const data: EntityDashboard = { ...DATA, meta: { query: MATCHING_QUERY } };
    render(
      <EntityDashboardModal
        selection={{ kind: 'model', name: 'gpt-5-codex' }}
        range="today"
        scope="local"
        data={data}
        loading={false}
        error=""
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={vi.fn()}
        globalCostContext={{ totalCost: 100, query: MATCHING_QUERY, scope: 'cloud' }}
      />,
    );
    expect(screen.queryByText('占总预估费用')).not.toBeInTheDocument();
  });

  it('实体查询被额外的工具/模型/搜索筛选收窄时隐藏整项，即使 globalCostContext 已提供', () => {
    const narrowedQuery: StatsQueryContext = { ...MATCHING_QUERY, tools: ['claude'] };
    const data: EntityDashboard = { ...DATA, meta: { query: narrowedQuery } };
    render(
      <EntityDashboardModal
        selection={{ kind: 'model', name: 'gpt-5-codex' }}
        range="today"
        scope="local"
        data={data}
        loading={false}
        error=""
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={vi.fn()}
        globalCostContext={{ totalCost: 100, query: MATCHING_QUERY, scope: 'local' }}
      />,
    );
    expect(screen.queryByText('占总预估费用')).not.toBeInTheDocument();
  });

  it('可比较但全局总额为 0 时显示"不可得"，不做除以 0 或假 0%', () => {
    const data: EntityDashboard = { ...DATA, meta: { query: MATCHING_QUERY, generatedAt: MATCHING_GENERATED_AT } };
    render(
      <EntityDashboardModal
        selection={{ kind: 'model', name: 'gpt-5-codex' }}
        range="today"
        scope="local"
        data={data}
        loading={false}
        error=""
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={vi.fn()}
        globalCostContext={{ totalCost: 0, query: MATCHING_QUERY, scope: 'local', generatedAt: MATCHING_GENERATED_AT }}
      />,
    );
    expect(screen.getByText('占总预估费用').closest('div')).toHaveTextContent('占总预估费用不可得');
  });

  it('单位费用不把缓存计入分母：缓存与有效 Token 同量级时结果仍只按 输入+输出 计算（复核修复 P3-6，原测试的缓存量太小不足以证明）', () => {
    const data: EntityDashboard = {
      ...DATA,
      summary: { ...SUMMARY, totalCost: 12, inputTokens: 3_000_000, outputTokens: 3_000_000, cachedTokens: 6_000_000 },
    };
    renderModal(data);
    // 若实现错误地把 cachedTokens 也加进分母（12M 而非 6M），结果会是 ≈$1.00，
    // 与预期的 ≈$2.00 明显不同，足以让这条断言在回归时失败。
    expect(screen.getByText('单位费用').closest('div')).toHaveTextContent('单位费用≈$2.00/百万 Token');
  });

  it('输入或输出 Token 本身不可得（NaN）时单位费用显示"不可得"，不用 0 补另一侧凑出误导性数字（复核修复 P3-3）', () => {
    const data: EntityDashboard = {
      ...DATA,
      summary: { ...SUMMARY, totalCost: 12, inputTokens: Number.NaN, outputTokens: 3_000_000 },
    };
    renderModal(data);
    expect(screen.getByText('单位费用').closest('div')).toHaveTextContent('单位费用不可得');
  });

  it('单位费用低于 $0.01/百万 Token 时显示"<$0.01/百万 Token"，不四舍五入成看似免费的 $0.00（复核修复 P3-4）', () => {
    const data: EntityDashboard = {
      ...DATA,
      summary: { ...SUMMARY, totalCost: 0.001, inputTokens: 3_000_000, outputTokens: 3_000_000 },
    };
    renderModal(data);
    expect(screen.getByText('单位费用').closest('div')).toHaveTextContent('单位费用<$0.01/百万 Token');
  });

  it('复核修复 P2-2：双向核对——全局查询反而被收窄（entity 没有额外筛选）时同样隐藏整项，不是只查 entity 一侧', () => {
    const narrowedGlobalQuery: StatsQueryContext = { ...MATCHING_QUERY, tools: ['claude'] };
    const data: EntityDashboard = { ...DATA, meta: { query: MATCHING_QUERY } };
    render(
      <EntityDashboardModal
        selection={{ kind: 'model', name: 'gpt-5-codex' }}
        range="today"
        scope="local"
        data={data}
        loading={false}
        error=""
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={vi.fn()}
        globalCostContext={{ totalCost: 100, query: narrowedGlobalQuery, scope: 'local' }}
      />,
    );
    expect(screen.queryByText('占总预估费用')).not.toBeInTheDocument();
  });

  it('复核修复 P2-2：时区不同时隐藏整项，即使其余字段都相同', () => {
    const differentTimezoneQuery: StatsQueryContext = { ...MATCHING_QUERY, timezone: 'Asia/Shanghai' };
    const data: EntityDashboard = { ...DATA, meta: { query: differentTimezoneQuery } };
    render(
      <EntityDashboardModal
        selection={{ kind: 'model', name: 'gpt-5-codex' }}
        range="today"
        scope="local"
        data={data}
        loading={false}
        error=""
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={vi.fn()}
        globalCostContext={{ totalCost: 100, query: MATCHING_QUERY, scope: 'local' }}
      />,
    );
    expect(screen.queryByText('占总预估费用')).not.toBeInTheDocument();
  });

  it('复核修复 P2-2：globalCostContext.stale 为 true（缓存快照）时隐藏整项，不用可能过期的全局总数拼百分比', () => {
    const data: EntityDashboard = { ...DATA, meta: { query: MATCHING_QUERY } };
    render(
      <EntityDashboardModal
        selection={{ kind: 'model', name: 'gpt-5-codex' }}
        range="today"
        scope="local"
        data={data}
        loading={false}
        error=""
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={vi.fn()}
        globalCostContext={{ totalCost: 100, query: MATCHING_QUERY, scope: 'local', stale: true }}
      />,
    );
    expect(screen.queryByText('占总预估费用')).not.toBeInTheDocument();
  });

  it('复核修复 P2-2：分子大于分母（口径已通过校验但比例超过 100%）时显示"不可得"，不展示会误导的 ">100%"', () => {
    const data: EntityDashboard = {
      ...DATA,
      summary: { ...SUMMARY, totalCost: 150 },
      meta: { query: MATCHING_QUERY, generatedAt: MATCHING_GENERATED_AT },
    };
    render(
      <EntityDashboardModal
        selection={{ kind: 'model', name: 'gpt-5-codex' }}
        range="today"
        scope="local"
        data={data}
        loading={false}
        error=""
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={vi.fn()}
        globalCostContext={{ totalCost: 100, query: MATCHING_QUERY, scope: 'local', generatedAt: MATCHING_GENERATED_AT }}
      />,
    );
    expect(screen.getByText('占总预估费用').closest('div')).toHaveTextContent('占总预估费用不可得');
  });

  it('复核修复 P2-2：真实占比小于 1% 时显示"<1%"，不四舍五入抹成看起来完全没消耗的"0%"', () => {
    const data: EntityDashboard = {
      ...DATA,
      summary: { ...SUMMARY, totalCost: 0.4 },
      meta: { query: MATCHING_QUERY, generatedAt: MATCHING_GENERATED_AT },
    };
    render(
      <EntityDashboardModal
        selection={{ kind: 'model', name: 'gpt-5-codex' }}
        range="today"
        scope="local"
        data={data}
        loading={false}
        error=""
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={vi.fn()}
        globalCostContext={{ totalCost: 100, query: MATCHING_QUERY, scope: 'local', generatedAt: MATCHING_GENERATED_AT }}
      />,
    );
    expect(screen.getByText('占总预估费用').closest('div')).toHaveTextContent('占总预估费用<1%');
  });

  it('复核修复 R2-2：entity 或全局一侧缺失 generatedAt 时隐藏整项，不假定两份快照同时刻抓取', () => {
    const data: EntityDashboard = { ...DATA, meta: { query: MATCHING_QUERY } };
    render(
      <EntityDashboardModal
        selection={{ kind: 'model', name: 'gpt-5-codex' }}
        range="today"
        scope="local"
        data={data}
        loading={false}
        error=""
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={vi.fn()}
        globalCostContext={{ totalCost: 100, query: MATCHING_QUERY, scope: 'local', generatedAt: MATCHING_GENERATED_AT }}
      />,
    );
    expect(screen.queryByText('占总预估费用')).not.toBeInTheDocument();
  });

  it('复核修复 R2-2：两侧 generatedAt 相差超过 5 分钟阈值时隐藏整项，即使同一自然日', () => {
    const data: EntityDashboard = {
      ...DATA,
      meta: { query: MATCHING_QUERY, generatedAt: '2026-09-24T10:00:00.000Z' },
    };
    render(
      <EntityDashboardModal
        selection={{ kind: 'model', name: 'gpt-5-codex' }}
        range="today"
        scope="local"
        data={data}
        loading={false}
        error=""
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={vi.fn()}
        globalCostContext={{
          totalCost: 100, query: MATCHING_QUERY, scope: 'local',
          generatedAt: '2026-09-24T10:06:00.000Z',
        }}
      />,
    );
    expect(screen.queryByText('占总预估费用')).not.toBeInTheDocument();
  });

  it('复核修复 R2-2：两侧相差不到 1 分钟但恰好跨过查询时区的午夜边界时仍隐藏整项，不假定同一自然日', () => {
    const data: EntityDashboard = {
      ...DATA,
      meta: { query: MATCHING_QUERY, generatedAt: '2026-09-24T23:59:50.000Z' },
    };
    render(
      <EntityDashboardModal
        selection={{ kind: 'model', name: 'gpt-5-codex' }}
        range="today"
        scope="local"
        data={data}
        loading={false}
        error=""
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={vi.fn()}
        globalCostContext={{
          totalCost: 100, query: MATCHING_QUERY, scope: 'local',
          generatedAt: '2026-09-25T00:00:10.000Z',
        }}
      />,
    );
    expect(screen.queryByText('占总预估费用')).not.toBeInTheDocument();
  });
});

describe('R2-1（root 2026-09-24 定夺）：单位费用格与 T10.159 TrendPanel 去重', () => {
  it('data.comparison 不存在时显示本组件的单位费用格', () => {
    const data: EntityDashboard = {
      ...DATA,
      summary: { ...SUMMARY, totalCost: 12, inputTokens: 3_000_000, outputTokens: 3_000_000 },
      comparison: null,
    };
    renderModal(data);
    expect(screen.getByText('单位费用')).toBeInTheDocument();
  });

  it('data.comparison 存在时隐藏本组件的单位费用格，避免与 T10.159 TrendPanel 的同名格重复（root 2026-09-24 决定：由 root 在集成时接线，去重条件收在 showUnitCostCell）', () => {
    const comparison: EntityDashboard['comparison'] = {
      window: {
        kind: 'dayOverDay', timezone: 'UTC', bucket: 'day',
        currentStart: '2026-09-24', currentEnd: '2026-09-24',
        previousStart: '2026-09-23', previousEnd: '2026-09-23',
        alignedThrough: '2026-09-24',
      },
      current: { summary: SUMMARY, series: [] },
      previous: { summary: SUMMARY, series: [] },
      delta: {
        tokens: { absolute: 0, percent: 0, direction: 'flat' },
        requests: { absolute: 0, percent: 0, direction: 'flat' },
        cost: { absolute: 0, percent: 0, direction: 'flat' },
      },
    };
    const data: EntityDashboard = {
      ...DATA,
      summary: { ...SUMMARY, totalCost: 12, inputTokens: 3_000_000, outputTokens: 3_000_000 },
      comparison,
    };
    renderModal(data);
    expect(screen.queryByText('单位费用')).not.toBeInTheDocument();
  });
});

describe('关闭后的焦点去向（T10.164 评审 N2，T10.179）', () => {
  /** App 的主内容区（`tabIndex=-1`）和其中打开专属看板的行按钮；焦点先在行按钮上。 */
  function mountOpener() {
    const main = document.createElement('section');
    main.id = 'main-content';
    main.tabIndex = -1;
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.textContent = 'minimax';
    main.appendChild(opener);
    document.body.appendChild(main);
    opener.focus();
    return { main, opener };
  }

  /** 像 App 一样：onClose 让父组件卸下专属看板。 */
  function ClosableModal() {
    const [open, setOpen] = useState(true);
    return open ? (
      <EntityDashboardModal
        selection={{ kind: 'model', name: 'gpt-5-codex' }}
        range="today"
        scope="local"
        data={DATA}
        loading={false}
        error=""
        onClose={() => setOpen(false)}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={vi.fn()}
      />
    ) : null;
  }

  afterEach(() => {
    document.getElementById('main-content')?.remove();
  });

  it('打开它的行按钮已随列表重建脱离文档时，关闭后焦点退回主内容区，不落到 body', () => {
    const { main, opener } = mountOpener();
    render(<ClosableModal />);
    expect(screen.getByRole('button', { name: '关闭专属看板' })).toHaveFocus();
    // 行为页越过预设窗口后从工具行下钻：先切范围，排行列表重建，按下的行按钮脱离文档。
    opener.remove();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(main).toHaveFocus();
  });

  it('打开它的元素仍在文档中时，关闭后焦点照旧回到它', () => {
    const { opener } = mountOpener();
    render(<ClosableModal />);
    expect(opener).not.toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
