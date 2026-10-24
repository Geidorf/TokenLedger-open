import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LogHistoryItem, UsageDetailsResponse } from '../types';
import { colorsForToolsInView } from '../types';
import { LogsTable } from './LogsTable';

const details: UsageDetailsResponse = {
  status: 'ok',
  items: [{
    id: 1,
    tool: 'codex',
    model: 'gpt-5-codex',
    inputTokens: 1200,
    outputTokens: 800,
    cachedTokens: 200,
    cacheWriteTokens: 40,
    cost: 0.01234,
    timestamp: '2026-08-21T06:30:00.000Z',
    sessionId: 'session-1',
    machineId: 'Studio-PC',
    requests: 1,
    granularity: 'request',
  }],
  nextCursor: null,
  hasMore: false,
  totalCount: 1,
  filteredSummary: {
    totalTokens: 2000,
    inputTokens: 1200,
    outputTokens: 800,
    cachedTokens: 200,
    cacheReadTokens: 160,
    cacheWriteTokens: 40,
    cacheSavedUsd: 0.01,
    totalCost: 0.01234,
    totalRequests: 1,
    avgTokensPerReq: 2000,
  },
  availableFilters: {
    tools: [{ value: 'codex', count: 1 }],
    models: [{ value: 'gpt-5-codex', count: 1 }],
    machines: [{ value: 'Studio-PC', count: 1 }],
  },
  granularity: 'request',
};

function renderLogsTable(customDetails: UsageDetailsResponse = details, scope: 'local' | 'cloud' = 'local') {
  render(
    <LogsTable
      details={customDetails}
      filters={{ tools: [], models: [], machines: [], search: '' }}
      loading={false}
      loadingMore={false}
      error=""
      scope={scope}
      range="today"
      onFilterChange={vi.fn()}
      onClearFilters={vi.fn()}
      onRetry={vi.fn()}
      onLoadMore={vi.fn()}
      onOpenEntity={vi.fn()}
    />,
  );
}

function mockHorizontalTable() {
  const table = screen.getByRole('region', { name: '明细记录表格，可横向滚动查看更多字段' });
  const scrollTo = vi.fn();
  Object.defineProperties(table, {
    clientWidth: { configurable: true, value: 240 },
    scrollWidth: { configurable: true, value: 840 },
    scrollLeft: { configurable: true, value: 0, writable: true },
    scrollTo: { configurable: true, value: scrollTo },
  });
  fireEvent.scroll(table);
  return { table, scrollTo };
}

describe('LogsTable 预估费用（T10.154 D43–D46）', () => {
  it('汇总条写「预估费用」两位小数，列头写「预估费用」，单元格按单条记录精度', () => {
    renderLogsTable();
    expect(screen.getByText('预估费用', { selector: 'span' }).nextElementSibling).toHaveTextContent(/^≈\$0\.01$/);
    expect(screen.getByRole('columnheader', { name: '预估费用' })).toBeInTheDocument();
    const summaryCell = screen.getByLabelText('记录摘要指标');
    expect(summaryCell).toHaveTextContent('≈$0.0123费用');
    const row = screen.getByRole('button', { name: '展开此记录详情' }).closest('tr') as HTMLElement;
    expect(within(row).getAllByText('≈$0.0123')).toHaveLength(2);
    // 旧格式是不带 ≈ 的五位小数（$0.01230）；逐格检查，避免相邻单元格的文字拼在一起误判。
    expect(within(row).queryByText(/^\$0\.0123\d/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/估算成本|成本/);
  });

  it('单条记录 ≥ $1 保留两位；未知费用写「不可得」，不再写 $0.00000', () => {
    renderLogsTable({
      ...details,
      items: [
        { ...details.items[0], id: 1, cost: 1.23456 },
        { ...details.items[0], id: 2, sessionId: 'session-2', cost: null as unknown as number },
      ],
      totalCount: 2,
    });
    const rows = screen.getAllByRole('button', { name: '展开此记录详情' }).map((button) => button.closest('tr') as HTMLElement);
    expect(within(rows[0]).getAllByText('≈$1.23')).toHaveLength(2);
    expect(within(rows[1]).getAllByText('不可得')).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/\$0\.00000|\$0\.00(?!\d)/);
  });
});

describe('LogsTable', () => {
  it('只对本机支持来源提供整个会话分析入口，云端记录不能映射本地 ID', () => {
    renderLogsTable(details, 'cloud');
    fireEvent.click(screen.getByRole('button', { name: '展开此记录详情' }));
    expect(screen.queryByRole('button', { name: '分析整个会话' })).not.toBeInTheDocument();
    expect(screen.getByText(/原始日志所在电脑的本地明细/)).toBeInTheDocument();
  });

  it('本机 Claude 和 Codex 明细保留按需分析入口', () => {
    renderLogsTable();
    fireEvent.click(screen.getByRole('button', { name: '展开此记录详情' }));
    expect(screen.getByRole('button', { name: '分析整个会话' })).toBeInTheDocument();
  });

  it('窄屏筛选提供可展开的结果优先入口', () => {
    renderLogsTable();
    const toggle = screen.getByRole('button', { name: '展开筛选' });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'detail-filter-controls');

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: '收起筛选' })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: '收起筛选' }));
    expect(screen.getByRole('button', { name: '展开筛选' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('当明细行承载多次请求时明确标记为日志聚合', () => {
    renderLogsTable({
      ...details,
      items: [{ ...details.items[0], requests: 738 }],
      filteredSummary: { ...details.filteredSummary, totalRequests: 738 },
    });

    expect(screen.getByText('日志聚合')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开此记录详情' }));
    expect(screen.getAllByText('日志聚合')).toHaveLength(2);
  });

  it('用可操作控件推进窄屏表格的隐藏字段', () => {
    renderLogsTable();
    const { scrollTo } = mockHorizontalTable();
    const cue = screen.getByRole('button', { name: '向右查看更多字段' });

    fireEvent.click(cue);
    fireEvent.keyDown(cue, { key: 'Enter' });
    fireEvent.keyDown(cue, { key: ' ' });

    expect(scrollTo).toHaveBeenNthCalledWith(1, { left: 192, behavior: 'smooth' });
    expect(scrollTo).toHaveBeenCalledTimes(3);
    expect(cue).toHaveAttribute('aria-controls', 'detail-log-table');
  });

  it('滚到末端后隐藏推进控件并把焦点交给表格区域', () => {
    renderLogsTable();
    const { table } = mockHorizontalTable();
    const cue = screen.getByRole('button', { name: '向右查看更多字段' });

    cue.focus();
    Object.defineProperty(table, 'scrollLeft', { configurable: true, value: 600, writable: true });
    fireEvent.scroll(table);

    expect(cue).toHaveAttribute('aria-hidden', 'true');
    expect(cue).toHaveAttribute('tabindex', '-1');
    expect(table).toHaveFocus();
  });

  it('Session ID 复制成功与失败都提供可确认的状态', async () => {
    const originalClipboard = navigator.clipboard;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      renderLogsTable();
      fireEvent.click(screen.getByRole('button', { name: '展开此记录详情' }));
      const copy = screen.getByRole('button', { name: '复制 Session ID' });

      fireEvent.click(copy);
      await waitFor(() => expect(screen.getByRole('button', { name: '已复制 Session ID' })).toBeInTheDocument());
      expect(writeText).toHaveBeenCalledWith('session-1');

      writeText.mockRejectedValueOnce(new Error('clipboard denied'));
      fireEvent.click(screen.getByRole('button', { name: '已复制 Session ID' }));
      await waitFor(() => expect(screen.getByRole('button', { name: '复制失败，点击重试 Session ID' })).toBeInTheDocument());
      expect(screen.getByText('剪贴板不可用，可选择上方完整 ID 后手动复制。')).toBeInTheDocument();
    } finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
    }
  });

  it('Session ID 复制进行中显示忙碌语义并阻止重复点击', async () => {
    let resolveWriteText: (() => void) | undefined;
    const originalClipboard = navigator.clipboard;
    const writeText = vi.fn(() => new Promise<void>((resolve) => {
      resolveWriteText = resolve;
    }));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      renderLogsTable();
      fireEvent.click(screen.getByRole('button', { name: '展开此记录详情' }));
      fireEvent.click(screen.getByRole('button', { name: '复制 Session ID' }));

      const copying = screen.getByRole('button', { name: '正在复制 Session ID' });
      expect(copying).toBeDisabled();
      expect(copying).toHaveAttribute('aria-busy', 'true');
      fireEvent.click(copying);
      expect(writeText).toHaveBeenCalledTimes(1);

      resolveWriteText?.();
      await waitFor(() => expect(screen.getByRole('button', { name: '已复制 Session ID' })).toBeInTheDocument());
    } finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
    }
  });

  it('文本搜索支持 300ms 防抖并支持 Enter 键立即触发', async () => {
    vi.useFakeTimers();
    try {
      const onFilterChange = vi.fn();
      render(
        <LogsTable
          details={details}
          filters={{ tools: [], models: [], machines: [], search: '' }}
          loading={false}
          loadingMore={false}
          error=""
          scope="local"
          range="today"
          onFilterChange={onFilterChange}
          onClearFilters={vi.fn()}
          onRetry={vi.fn()}
          onLoadMore={vi.fn()}
          onOpenEntity={vi.fn()}
        />,
      );

      const input = screen.getByRole('textbox', { name: '搜索工具、模型、设备或 Session' });
      fireEvent.change(input, { target: { value: 'gpt-5' } });

      // Before 300ms, onFilterChange should not be called yet
      vi.advanceTimersByTime(200);
      expect(onFilterChange).not.toHaveBeenCalled();

      // After remaining 100ms (total 300ms), onFilterChange should be called with debounced query
      vi.advanceTimersByTime(100);
      expect(onFilterChange).toHaveBeenCalledWith('search', 'gpt-5');

      // Test immediate Enter key handling
      fireEvent.change(input, { target: { value: 'codex-immediate' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onFilterChange).toHaveBeenCalledWith('search', 'codex-immediate');
    } finally {
      vi.useRealTimers();
    }
  });

  it('单日复盘在页头说明正在看哪天，并给出返回原范围的入口', () => {
    const onReturn = vi.fn();
    render(
      <LogsTable
        details={details}
        filters={{ tools: [], models: [], machines: [], search: '' }}
        loading={false}
        loadingMore={false}
        error=""
        scope="local"
        range="custom"
        customRange={{ start: '2026-09-12', end: '2026-09-12' }}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
        onRetry={vi.fn()}
        onLoadMore={vi.fn()}
        onOpenEntity={vi.fn()}
        dayDrill={{ day: '9月12日', origin: '总览', returnLabel: '返回本月', returnAriaLabel: '返回本月：回到总览并恢复原筛选' }}
        onReturnFromDayDrill={onReturn}
      />,
    );
    const chip = screen.getByRole('group', { name: '单日复盘：9月12日' });
    expect(chip).toHaveTextContent('正在查看 9月12日 · 来自总览');
    const back = screen.getByRole('button', { name: '返回本月：回到总览并恢复原筛选' });
    expect(back).toHaveTextContent('返回本月');
    expect(back).toHaveClass('secondary-inline');
    fireEvent.click(back);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('没有下钻来源时不显示返回入口', () => {
    renderLogsTable();
    expect(screen.queryByRole('group', { name: /单日复盘/ })).not.toBeInTheDocument();
  });
});

describe('LogsTable tool colours (T10.178 review P1-1)', () => {
  function hexToRgbString(hex: string): string {
    const int = parseInt(hex.slice(1), 16);
    return `rgb(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255})`;
  }

  // antigravity and gemini both primary to chart-slot 1 (§3.8) — the same
  // same-slot pair the independent review found colliding elsewhere in the
  // app once same-view collision-shift was missing (P1-1). antigravity has
  // the larger token sum, so it keeps slot 1 and gemini shifts.
  const collidingDetails: UsageDetailsResponse = {
    ...details,
    items: [
      { ...details.items[0], id: 1, tool: 'antigravity', inputTokens: 5000, outputTokens: 2000, sessionId: 'session-a' },
      { ...details.items[0], id: 2, tool: 'gemini', inputTokens: 1000, outputTokens: 500, sessionId: 'session-b' },
    ] as LogHistoryItem[],
    totalCount: 2,
  };

  function dotColor(toolTitle: string): string | undefined {
    const button = screen.getAllByTitle(toolTitle)[0];
    const dot = within(button).getByText('', { selector: '.entity-dot' });
    return dot.style.color || undefined;
  }

  it('colours two rows whose tools collide on the same primary slot differently, ranked by each tool\'s summed effective tokens in the loaded rows', () => {
    renderLogsTable(collidingDetails);
    const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const [antigravityColor, geminiColor] = colorsForToolsInView(['antigravity', 'gemini'], theme);
    expect(dotColor('打开 antigravity 专属看板')).toBe(hexToRgbString(antigravityColor));
    expect(dotColor('打开 gemini 专属看板')).toBe(hexToRgbString(geminiColor));
    expect(dotColor('打开 antigravity 专属看板')).not.toBe(dotColor('打开 gemini 专属看板'));
  });

  it('two rows of the same tool share that tool\'s one (post-shift) colour', () => {
    const sameToolDetails: UsageDetailsResponse = {
      ...details,
      items: [
        { ...details.items[0], id: 1, tool: 'gemini', inputTokens: 5000, outputTokens: 2000, sessionId: 'session-a' },
        { ...details.items[0], id: 2, tool: 'gemini', inputTokens: 1000, outputTokens: 500, sessionId: 'session-b' },
      ] as LogHistoryItem[],
      totalCount: 2,
    };
    renderLogsTable(sameToolDetails);
    const buttons = screen.getAllByTitle('打开 gemini 专属看板');
    const colors = buttons.map((button) => within(button).getByText('', { selector: '.entity-dot' }).style.color);
    expect(new Set(colors).size).toBe(1);
  });
});

describe('LogsTable 导出与缓存命中率', () => {
  const baseProps = {
    filters: { tools: [], models: [], machines: [], search: '' },
    loading: false,
    loadingMore: false,
    error: '',
    scope: 'local' as const,
    range: 'today' as const,
    onFilterChange: vi.fn(),
    onClearFilters: vi.fn(),
    onRetry: vi.fn(),
    onLoadMore: vi.fn(),
    onOpenEntity: vi.fn(),
  };

  it('summarises the cache hit rate from the filtered summary', () => {
    render(<LogsTable {...baseProps} details={details} />);
    const summary = document.querySelector('.details-summary') as HTMLElement;
    // 160 ÷ (1200 + 160)
    expect(within(summary).getByText('缓存命中率').nextElementSibling?.textContent).toBe('11.8%');
  });

  it('says the hit rate is unavailable when the summary has no read/write split', () => {
    const { cacheReadTokens: _read, cacheWriteTokens: _write, ...legacySummary } = details.filteredSummary;
    render(<LogsTable {...baseProps} details={{ ...details, filteredSummary: legacySummary }} />);
    const summary = document.querySelector('.details-summary') as HTMLElement;
    expect(within(summary).getByText('缓存命中率').nextElementSibling?.textContent).toBe('不可得');
  });

  it('offers CSV export only when wired, and disables it while exporting', () => {
    const onExportCsv = vi.fn();
    const { rerender } = render(<LogsTable {...baseProps} details={details} />);
    expect(screen.queryByRole('button', { name: /导出 CSV/ })).toBeNull();

    rerender(<LogsTable {...baseProps} details={details} onExportCsv={onExportCsv} />);
    fireEvent.click(screen.getByRole('button', { name: /导出 CSV/ }));
    expect(onExportCsv).toHaveBeenCalledTimes(1);

    rerender(<LogsTable {...baseProps} details={details} onExportCsv={onExportCsv} exporting />);
    expect(screen.getByRole('button', { name: /导出中/ })).toBeDisabled();
  });

  it('summarises output speed only when the summary carries timed gateway rows', () => {
    const { rerender } = render(<LogsTable {...baseProps} details={details} />);
    let summary = document.querySelector('.details-summary') as HTMLElement;
    expect(within(summary).queryByText('输出速度')).toBeNull();

    rerender(<LogsTable {...baseProps} details={{
      ...details,
      filteredSummary: { ...details.filteredSummary, timedRequests: 2, timedOutputTokens: 600, timedLatencyMs: 4000 },
    }} />);
    summary = document.querySelector('.details-summary') as HTMLElement;
    expect(within(summary).getByText('输出速度').nextElementSibling?.textContent).toBe('150.0 tok/s');
  });

  it('shows duration and output speed only for rows that carry a latency', () => {
    const timed: UsageDetailsResponse = {
      ...details,
      items: [
        { ...details.items[0], id: 1, outputTokens: 300, latencyMs: 1500, source: 'gateway' },
        { ...details.items[0], id: 2, sessionId: 'untimed' },
      ] as LogHistoryItem[],
      totalCount: 2,
    };
    render(<LogsTable {...baseProps} details={timed} />);
    const expandButtons = screen.getAllByRole('button', { name: '展开此记录详情' });
    fireEvent.click(expandButtons[0]);
    let detail = document.querySelector('.log-detail-row') as HTMLElement;
    expect(within(detail).getByText('耗时').nextElementSibling?.textContent).toBe('1.5 s');
    expect(within(detail).getByText('输出速度').nextElementSibling?.textContent).toBe('200.0 tok/s');

    fireEvent.click(screen.getAllByRole('button', { name: '展开此记录详情' })[0]);
    detail = document.querySelector('.log-detail-row') as HTMLElement;
    expect(within(detail).queryByText('耗时')).toBeNull();
    expect(within(detail).queryByText('输出速度')).toBeNull();
  });

  it('shows the estimated context composition only for rows that carry one', () => {
    const composed: UsageDetailsResponse = {
      ...details,
      items: [
        {
          ...details.items[0], id: 1, inputTokens: 900, cachedTokens: 100, source: 'gateway',
          context: { systemBytes: 100, toolsBytes: 600, historyBytes: 300, toolResultsBytes: 0, attachmentsBytes: 0, messages: 4, toolResults: 0, attachments: 0 },
        },
        { ...details.items[0], id: 2, sessionId: 'plain' },
      ] as LogHistoryItem[],
      totalCount: 2,
    };
    render(<LogsTable {...baseProps} details={composed} />);
    fireEvent.click(screen.getAllByRole('button', { name: '展开此记录详情' })[0]);
    let detail = document.querySelector('.log-detail-row') as HTMLElement;
    expect(within(detail).getByRole('img', { name: '系统提示 10%，工具定义 60%，对话历史 30%' })).toBeInTheDocument();
    expect(within(detail).getByText('工具定义').querySelector('b')?.textContent).toBe('≈600');
    expect(within(detail).getByText('4 条消息')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: '展开此记录详情' })[0]);
    detail = document.querySelector('.log-detail-row') as HTMLElement;
    expect(within(detail).queryByText(/Context 构成/)).toBeNull();
  });
});
