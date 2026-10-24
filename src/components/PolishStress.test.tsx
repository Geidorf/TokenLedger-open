import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogsTable } from './LogsTable';
import { EntityDashboardModal } from './EntityDashboardModal';
import { DashboardTab } from './DashboardTab';
import { AnomalySpikePanel } from './AnomalySpikePanel';
import { TokenModeToggle } from './RangeControls';
import { colorForTool, getPalette, PALETTE_DARK, PALETTE_LIGHT, toolChartSlot, type EntityDashboard, type StatsData, type UsageDetailsResponse } from '../types';

vi.mock('./MetricsGrid', () => ({ MetricsGrid: () => <div data-testid="metrics-grid">metrics</div> }));
vi.mock('./TrendPanel', () => ({ TrendPanel: () => <div data-testid="trend-panel">trend</div> }));
vi.mock('./YearHeatmap', () => ({ YearHeatmap: () => <div data-testid="year-heatmap">heatmap</div> }));

function relativeLuminance(hex: string): number {
  const cleanHex = hex.replace('#', '');
  const r = parseInt(cleanHex.substring(0, 2), 16) / 255;
  const g = parseInt(cleanHex.substring(2, 4), 16) / 255;
  const b = parseInt(cleanHex.substring(4, 6), 16) / 255;
  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
  document.documentElement.removeAttribute('data-theme');
});

describe('Empirical Stress Test: Theme Palette Resolution & Contrast', () => {
  const ALL_TOOLS = [
    'antigravity', 'claude', 'codex', 'opencode', 'kilo', 'kimi', 'kimidesktop',
    'minimax', 'qclaw', 'reasonix', 'trae', 'workbuddy', 'marvis', 'mavis',
    'deepseek', 'deepseekgui', 'dsh', 'hermes', 'zcode', 'grok', 'gemini', 'pi',
  ];
  // T10.187 (palette B, user decision U-4) retuned --chart-4's light value so
  // every one of the 8 chart slots now clears 3:1 against the bare light page,
  // not just the card/panel: the old chart-slot-4 carve-out (opencode,
  // workbuddy fell to ~2.92:1) and its "KNOWN GAP" floor test are gone.

  it('all 22 light tool colors and 7 palette colors achieve >= 3.0:1 contrast against the T10.150 light panel (#ffffff) and the bare page (#f4f5f7)', () => {
    const white = '#ffffff';
    const surface = '#f4f5f7';

    for (const tool of ALL_TOOLS) {
      const color = colorForTool(tool, 0, 'light');
      const crWhite = contrastRatio(color, white);
      expect(crWhite, `Tool ${tool} (${color}) vs white`).toBeGreaterThanOrEqual(3.0);
      const crSurface = contrastRatio(color, surface);
      expect(crSurface, `Tool ${tool} (${color}) vs light surface`).toBeGreaterThanOrEqual(3.0);
    }

    for (let i = 0; i < PALETTE_LIGHT.length; i++) {
      const color = PALETTE_LIGHT[i];
      const crWhite = contrastRatio(color, white);
      const crSurface = contrastRatio(color, surface);
      expect(crWhite, `Palette[${i}] (${color}) vs white`).toBeGreaterThanOrEqual(3.0);
      expect(crSurface, `Palette[${i}] (${color}) vs light surface`).toBeGreaterThanOrEqual(3.0);
    }
  });

  it('all 22 dark tool colors and 7 palette colors achieve >= 3.0:1 contrast against the T10.150 dark page (#0d0f13) and popover (#1d2129)', () => {
    const darkBg = '#0d0f13';
    const darkSurface = '#1d2129';

    for (const tool of ALL_TOOLS) {
      const color = colorForTool(tool, 0, 'dark');
      const crBg = contrastRatio(color, darkBg);
      const crSurface = contrastRatio(color, darkSurface);
      expect(crBg, `Tool ${tool} (${color}) vs dark bg`).toBeGreaterThanOrEqual(3.0);
      expect(crSurface, `Tool ${tool} (${color}) vs dark surface`).toBeGreaterThanOrEqual(3.0);
    }

    for (let i = 0; i < PALETTE_DARK.length; i++) {
      const color = PALETTE_DARK[i];
      const crBg = contrastRatio(color, darkBg);
      const crSurface = contrastRatio(color, darkSurface);
      expect(crBg, `Palette[${i}] (${color}) vs dark bg`).toBeGreaterThanOrEqual(3.0);
      expect(crSurface, `Palette[${i}] (${color}) vs dark surface`).toBeGreaterThanOrEqual(3.0);
    }
  });

  it('colorForTool resolves case-insensitively, hashes unknown tools into a stable slot, and infers theme from document data-theme attribute', () => {
    // Case insensitivity
    expect(colorForTool('CLAUDE', 0, 'light')).toBe('#16a34a');
    expect(colorForTool('OpenCode', 0, 'light')).toBe('#d57501');
    expect(colorForTool('cOdEx', 0, 'dark')).toBe('#907adc');

    // T10.178: an unknown tool now hashes into one of the same 8 chart slots
    // (not a separate neutral fallback list) — stable per name, independent
    // of the (now-ignored) legacy `index` argument.
    const slot = toolChartSlot('unknown_custom_tool');
    expect(slot).toBeGreaterThanOrEqual(1);
    expect(slot).toBeLessThanOrEqual(8);
    expect(colorForTool('unknown_custom_tool', 0, 'light')).toBe(colorForTool('unknown_custom_tool', 1, 'light'));
    expect(colorForTool('unknown_custom_tool', 0, 'light')).toBe(colorForTool('unknown_custom_tool', 99, 'light'));

    // Document attribute inference when theme argument is omitted
    document.documentElement.setAttribute('data-theme', 'light');
    expect(colorForTool('claude')).toBe('#16a34a');
    expect(getPalette()).toBe(PALETTE_LIGHT);

    document.documentElement.setAttribute('data-theme', 'dark');
    expect(colorForTool('claude')).toBe('#3fe480');
    expect(getPalette()).toBe(PALETTE_DARK);
  });
});

describe('Empirical Stress Test: LogsTable Rapid Debounce vs Immediate Enter & Submission', () => {
  const dummyDetails: UsageDetailsResponse = {
    status: 'ok',
    items: [{
      id: 1,
      tool: 'codex',
      model: 'gpt-5-codex',
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 0,
      cost: 0.01,
      timestamp: '2026-08-25T10:00:00.000Z',
      sessionId: 'session-123',
      machineId: 'MacBook-Pro',
      requests: 1,
      granularity: 'request',
    }],
    nextCursor: null,
    hasMore: false,
    totalCount: 1,
    filteredSummary: {
      totalTokens: 1500,
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 0,
      totalCost: 0.01,
      totalRequests: 1,
      avgTokensPerReq: 1500,
    },
    availableFilters: { tools: [], models: [], machines: [] },
    granularity: 'request',
  };

  it('rapid keystrokes do not invoke onFilterChange until 300ms after final keystroke', () => {
    vi.useFakeTimers();
    try {
      const onFilterChange = vi.fn();
      render(
        <LogsTable
          details={dummyDetails}
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

      // Simulate typing "gpt-5-codex" character by character with 50ms intervals
      const text = 'gpt-5-codex';
      for (let i = 1; i <= text.length; i++) {
        fireEvent.change(input, { target: { value: text.substring(0, i) } });
        if (i < text.length) {
          vi.advanceTimersByTime(50);
          expect(onFilterChange).not.toHaveBeenCalled();
        }
      }

      // After final keystroke: 200ms elapsed -> still not called
      vi.advanceTimersByTime(200);
      expect(onFilterChange).not.toHaveBeenCalled();

      // At 300ms (remaining 100ms) -> called exactly once with full query
      vi.advanceTimersByTime(100);
      expect(onFilterChange).toHaveBeenCalledTimes(1);
      expect(onFilterChange).toHaveBeenCalledWith('search', 'gpt-5-codex');
    } finally {
      vi.useRealTimers();
    }
  });

  it('pressing Enter immediately triggers search and cancels pending debounce timer (no duplicate call)', () => {
    vi.useFakeTimers();
    try {
      const onFilterChange = vi.fn();
      render(
        <LogsTable
          details={dummyDetails}
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
      fireEvent.change(input, { target: { value: 'claude-3-7' } });

      // Wait 100ms and press Enter
      vi.advanceTimersByTime(100);
      expect(onFilterChange).not.toHaveBeenCalled();

      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onFilterChange).toHaveBeenCalledTimes(1);
      expect(onFilterChange).toHaveBeenCalledWith('search', 'claude-3-7');

      // Advance by 300ms to ensure no redundant second invocation occurs
      vi.advanceTimersByTime(300);
      expect(onFilterChange).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('form submit button immediately triggers search and clear button immediately resets search', () => {
    vi.useFakeTimers();
    try {
      const onFilterChange = vi.fn();
      const view = render(
        <LogsTable
          details={dummyDetails}
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
      fireEvent.change(input, { target: { value: 'custom-query' } });

      const submitBtn = screen.getByRole('button', { name: '应用明细搜索' });
      fireEvent.click(submitBtn);

      expect(onFilterChange).toHaveBeenCalledWith('search', 'custom-query');

      // Now rerender with updated search in props to simulate parent update
      view.rerender(
        <LogsTable
          details={dummyDetails}
          filters={{ tools: [], models: [], machines: [], search: 'custom-query' }}
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

      const clearBtn = screen.getByRole('button', { name: '清除文本搜索' });
      fireEvent.click(clearBtn);

      expect(onFilterChange).toHaveBeenCalledWith('search', '');
      expect(input).toHaveValue('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('external filter change prop updates searchDraft without triggering recursive onFilterChange', () => {
    const onFilterChange = vi.fn();
    const view = render(
      <LogsTable
        details={dummyDetails}
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
    expect(input).toHaveValue('');

    // Parent updates filter externally
    view.rerender(
      <LogsTable
        details={dummyDetails}
        filters={{ tools: [], models: [], machines: [], search: 'preset-query' }}
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

    expect(input).toHaveValue('preset-query');
    expect(onFilterChange).not.toHaveBeenCalled();
  });
});

describe('Empirical Stress Test: EntityDashboardModal Multi-Level History Stack & Breadcrumbs', () => {
  const makeEntityDashboard = (kind: 'tool' | 'model', name: string, subItems: string[]): EntityDashboard => ({
    status: 'ok',
    entity: kind === 'tool' ? { kind: 'tool', tool: name } : { kind: 'model', model: name },
    summary: {
      totalTokens: 5000,
      inputTokens: 3000,
      outputTokens: 2000,
      cachedTokens: 500,
      totalCost: 0.25,
      totalRequests: 10,
      avgTokensPerReq: 500,
    },
    composition: {
      tools: kind === 'model' ? subItems.map((tool) => ({ value: tool, tokens: 1000, requests: 2, cost: 0.05 })) : [],
      models: kind === 'tool' ? subItems.map((model) => ({ value: model, tokens: 1000, requests: 2, cost: 0.05 })) : [],
      machines: [{ value: 'Studio-PC', tokens: 5000, requests: 10, cost: 0.25 }],
    },
    heatmap: { '2026-08-20': 5000 },
    peak: { bucket: '2026-08-20 14:00', tokens: 2500, requests: 5, cost: 0.12 },
    activity: { activeDays: 1, firstSeenAt: '2026-08-20T00:00:00Z', lastSeenAt: '2026-08-20T23:59:59Z' },
    historyPage: {
      status: 'ok',
      items: [],
      nextCursor: null,
      hasMore: false,
      totalCount: 0,
      filteredSummary: { totalTokens: 5000, inputTokens: 3000, outputTokens: 2000, cachedTokens: 500, totalCost: 0.25, totalRequests: 10, avgTokensPerReq: 500 },
      availableFilters: { tools: [], models: [], machines: [] },
      granularity: 'request',
    },
    granularity: 'request',
  });

  it('drill-down 3 levels deep builds correct breadcrumb trail, intermediate jump pops stack correctly, and Escape closes modal', () => {
    const onOpenEntity = vi.fn();
    const onClose = vi.fn();

    // Step 1: Initial Tool View (Claude)
    const claudeData = makeEntityDashboard('tool', 'claude', ['claude-3-5-sonnet', 'claude-3-opus']);
    const view = render(
      <EntityDashboardModal
        selection={{ kind: 'tool', name: 'claude' }}
        range="today"
        scope="local"
        data={claudeData}
        loading={false}
        error=""
        onClose={onClose}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={onOpenEntity}
      />,
    );

    // Initial state: No back button or breadcrumb navigation
    expect(screen.queryByRole('navigation', { name: '专属看板导航历史' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '返回上一个看板' })).not.toBeInTheDocument();

    // Step 2: Click on model "claude-3-5-sonnet"
    const modelBtn = screen.getByRole('button', { name: /claude-3-5-sonnet/ });
    fireEvent.click(modelBtn);
    expect(onOpenEntity).toHaveBeenLastCalledWith('model', 'claude-3-5-sonnet', 'claude');

    // Rerender as Level 2: Model View (claude-3-5-sonnet) with composition containing tools
    const sonnetData = makeEntityDashboard('model', 'claude-3-5-sonnet', ['claude', 'codex']);
    view.rerender(
      <EntityDashboardModal
        selection={{ kind: 'model', name: 'claude-3-5-sonnet', tool: 'claude' }}
        range="today"
        scope="local"
        data={sonnetData}
        loading={false}
        error=""
        onClose={onClose}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={onOpenEntity}
      />,
    );

    // Level 2 Breadcrumb: [claude > claude-3-5-sonnet]
    expect(screen.getByRole('navigation', { name: '专属看板导航历史' })).toBeInTheDocument();
    // Tool breadcrumbs render the canonical display name from toolDisplayName,
    // while callbacks keep the raw id `claude` (fixture names.json: Claude).
    expect(screen.getByRole('button', { name: '返回 Claude' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回上一个看板' })).toBeInTheDocument();

    // Step 3: Click on tool "codex" from model composition -> filters model to tool
    const codexBtn = screen.getByRole('button', { name: /^Codex/ });
    fireEvent.click(codexBtn);
    expect(onOpenEntity).toHaveBeenLastCalledWith('model', 'claude-3-5-sonnet', 'codex');

    // Rerender as Level 3: Model View (claude-3-5-sonnet scoped to codex)
    view.rerender(
      <EntityDashboardModal
        selection={{ kind: 'model', name: 'claude-3-5-sonnet', tool: 'codex' }}
        range="today"
        scope="local"
        data={sonnetData}
        loading={false}
        error=""
        onClose={onClose}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={onOpenEntity}
      />,
    );

    // Level 3 Breadcrumbs: [claude > claude-3-5-sonnet]
    expect(screen.getByRole('button', { name: '返回 Claude' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回 claude-3-5-sonnet' })).toBeInTheDocument();

    // Step 4: Intermediate breadcrumb jump back to "claude" (root)
    const rootBreadcrumb = screen.getByRole('button', { name: '返回 Claude' });
    fireEvent.click(rootBreadcrumb);
    expect(onOpenEntity).toHaveBeenLastCalledWith('tool', 'claude', undefined);

    // Rerender back at Level 1 (claude)
    view.rerender(
      <EntityDashboardModal
        selection={{ kind: 'tool', name: 'claude' }}
        range="today"
        scope="local"
        data={claudeData}
        loading={false}
        error=""
        onClose={onClose}
        onRetry={vi.fn()}
        onOpenDetails={vi.fn()}
        onOpenEntity={onOpenEntity}
      />,
    );

    // Stack should now be cleared back to 0
    expect(screen.queryByRole('navigation', { name: '专属看板导航历史' })).not.toBeInTheDocument();

    // Test Escape key closes modal
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Empirical Stress Test: DashboardTab Zero-Data Diagnostics & Actions', () => {
  const EMPTY_STATS: StatsData = {
    summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0, totalRequests: 0, avgTokensPerReq: 0 },
    tools: {},
    models: {},
    trends: [],
    heatmap: {},
    history: [],
  };

  const NON_EMPTY_STATS: StatsData = {
    summary: { totalTokens: 10000, inputTokens: 6000, outputTokens: 4000, cachedTokens: 2000, totalCost: 0.5, totalRequests: 20, avgTokensPerReq: 500 },
    tools: { codex: { name: 'codex', input: 6000, output: 4000, cached: 2000, total: 10000, cost: 0.5, requests: 20 } },
    models: { 'gpt-5': { name: 'gpt-5', input: 6000, output: 4000, cached: 2000, total: 10000, cost: 0.5, requests: 20 } },
    trends: [],
    heatmap: {},
    history: [],
  };

  it('renders all 7 supported AI tool paths in local zero-data mode and triggers action callbacks', () => {
    const onScan = vi.fn();
    const onOpenQuotaSettings = vi.fn();
    const onOpenCloudSettings = vi.fn();

    render(
      <DashboardTab
        stats={EMPTY_STATS}
        statsLoading={false}
        statsError=""
        statsErrorAction={null}
        scanBusy={false}
        syncBusy={false}
        activeTools={[]}
        topModels={[]}
        showTotalTokens={false}
        scope="local"
        range="today"
        cloudAuthenticated={true}
        cloudCapabilityVerified={true}
        quotaProviders={[]}
        quotaLoading={false}
        quotaError=""
        quotaSyncStatus={{ enabled: true, state: 'active' }}
        onQuotaSyncNow={vi.fn()}
        unsyncedRecords={0}
        onScan={onScan}
        onSync={vi.fn()}
        onOpenCloudSettings={onOpenCloudSettings}
        onRetryStats={vi.fn()}
        onRelogin={vi.fn()}
        onViewLocal={vi.fn()}
        onRefreshQuotas={vi.fn()}
        onOpenQuotaSettings={onOpenQuotaSettings}
        onQuotaNotify={vi.fn()}
        refreshCompletedAt=""
      />,
    );

    // Verify region and chips
    expect(screen.getByRole('region', { name: '本地日志扫描诊断与支持目录' })).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('~/.claude')).toBeInTheDocument();
    expect(screen.getByText('Codex CLI')).toBeInTheDocument();
    expect(screen.getByText('~/.codex')).toBeInTheDocument();
    expect(screen.getByText('Trae')).toBeInTheDocument();
    expect(screen.getByText('~/.trae')).toBeInTheDocument();
    expect(screen.getByText('Antigravity')).toBeInTheDocument();
    expect(screen.getByText('~/.antigravity')).toBeInTheDocument();
    expect(screen.getByText('OpenCode')).toBeInTheDocument();
    expect(screen.getByText('~/.opencode')).toBeInTheDocument();
    expect(screen.getByText('Kimi / Desktop')).toBeInTheDocument();
    expect(screen.getByText('~/.kimi')).toBeInTheDocument();
    expect(screen.getByText('MiniMax')).toBeInTheDocument();
    expect(screen.getByText('~/.minimax')).toBeInTheDocument();

    // Verify action buttons
    const scanBtn = screen.getByRole('button', { name: '扫描本地日志' });
    fireEvent.click(scanBtn);
    expect(onScan).toHaveBeenCalledTimes(1);

    const quotaBtn = screen.getByRole('button', { name: '配置额度与来源' });
    fireEvent.click(quotaBtn);
    expect(onOpenQuotaSettings).toHaveBeenCalledTimes(1);

    const settingsBtn = screen.getByRole('button', { name: '云端与常规设置' });
    fireEvent.click(settingsBtn);
    expect(onOpenCloudSettings).toHaveBeenCalledTimes(1);
  });

  it('disables scan action when scanBusy is true', () => {
    render(
      <DashboardTab
        stats={EMPTY_STATS}
        statsLoading={false}
        statsError=""
        statsErrorAction={null}
        scanBusy={true}
        syncBusy={false}
        activeTools={[]}
        topModels={[]}
        showTotalTokens={false}
        scope="local"
        range="today"
        cloudAuthenticated={true}
        cloudCapabilityVerified={true}
        quotaProviders={[]}
        quotaLoading={false}
        quotaError=""
        quotaSyncStatus={{ enabled: true, state: 'active' }}
        onQuotaSyncNow={vi.fn()}
        unsyncedRecords={0}
        onScan={vi.fn()}
        onSync={vi.fn()}
        onOpenCloudSettings={vi.fn()}
        onRetryStats={vi.fn()}
        onRelogin={vi.fn()}
        onViewLocal={vi.fn()}
        onRefreshQuotas={vi.fn()}
        onOpenQuotaSettings={vi.fn()}
        onQuotaNotify={vi.fn()}
        refreshCompletedAt=""
      />,
    );

    expect(screen.getByRole('button', { name: '正在扫描本地日志' })).toBeDisabled();
  });

  it('does not render zero-data diagnostics when stats has token volume', () => {
    render(
      <DashboardTab
        stats={NON_EMPTY_STATS}
        statsLoading={false}
        statsError=""
        statsErrorAction={null}
        scanBusy={false}
        syncBusy={false}
        activeTools={[{ name: 'codex', input: 6000, output: 4000, cached: 2000, total: 10000, cost: 0.5, requests: 20 }]}
        topModels={[{ name: 'gpt-5', input: 6000, output: 4000, cached: 2000, total: 10000, cost: 0.5, requests: 20 }]}
        showTotalTokens={false}
        scope="local"
        range="today"
        cloudAuthenticated={true}
        cloudCapabilityVerified={true}
        quotaProviders={[]}
        quotaLoading={false}
        quotaError=""
        quotaSyncStatus={{ enabled: true, state: 'active' }}
        onQuotaSyncNow={vi.fn()}
        unsyncedRecords={0}
        onScan={vi.fn()}
        onSync={vi.fn()}
        onOpenCloudSettings={vi.fn()}
        onRetryStats={vi.fn()}
        onRelogin={vi.fn()}
        onViewLocal={vi.fn()}
        onRefreshQuotas={vi.fn()}
        onOpenQuotaSettings={vi.fn()}
        onQuotaNotify={vi.fn()}
        refreshCompletedAt=""
      />,
    );

    expect(screen.queryByRole('region', { name: '本地日志扫描诊断与支持目录' })).not.toBeInTheDocument();
  });
});

describe('Empirical Stress Test: Keyboard Parity on Semantic Button Panels', () => {
  it('AnomalySpikePanel supports Enter and Space keys on drillable items and ignores non-drillable', () => {
    const onSelectDate = vi.fn();
    render(
      <AnomalySpikePanel
        detection={{
          state: 'flagged',
          bucketCount: 2,
          median: 1000,
          thresholdRatio: 3,
          spikes: [
            { date: '2026-08-15', value: 8000, ratio: 8, label: '8月15日', drillable: true, inProgress: false },
            { date: '2026-08-16', value: 5000, ratio: 5, label: '8月16日', drillable: false, inProgress: false },
          ],
        }}
        onSelectDate={onSelectDate}
      />,
    );

    // Drillable card is rendered as a button with aria-label
    const drillableBtn = screen.getByRole('button', { name: /2026-08-15/ });
    expect(drillableBtn).toBeInTheDocument();

    // Enter key triggers onSelectDate
    fireEvent.keyDown(drillableBtn, { key: 'Enter' });
    expect(onSelectDate).toHaveBeenLastCalledWith('2026-08-15');

    // Space key triggers onSelectDate
    fireEvent.keyDown(drillableBtn, { key: ' ' });
    expect(onSelectDate).toHaveBeenLastCalledWith('2026-08-15');

    // Non-drillable is not a button
    expect(screen.queryByRole('button', { name: /2026-08-16/ })).not.toBeInTheDocument();
    expect(screen.getByText('8月16日')).toBeInTheDocument();
  });
});

describe('Empirical Stress Test: Token Mode Zero-Cache Tooltip & Controls', () => {
  it('displays informative zero-cache tooltip when cachedTokens === 0 and standard toggle tooltip when cachedTokens > 0', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <TokenModeToggle showTotalTokens={false} onToggleTokenMode={onToggle} cachedTokens={0} />,
    );

    const zeroCacheEffectiveBtn = screen.getByRole('button', { name: '概览有效' });
    const zeroCacheTotalBtn = screen.getByRole('button', { name: '概览含缓存' });
    expect(zeroCacheEffectiveBtn).toHaveAttribute(
      'title',
      '当前周期未记录到缓存 Token；概览指标使用输入 + 输出 Token',
    );
    expect(zeroCacheTotalBtn).toHaveAttribute(
      'title',
      '当前周期未记录到缓存 Token，概览有效与含缓存数值相同',
    );

    // When cachedTokens > 0
    rerender(
      <TokenModeToggle showTotalTokens={false} onToggleTokenMode={onToggle} cachedTokens={5000} />,
    );

    const activeCacheEffectiveBtn = screen.getByRole('button', { name: '概览有效' });
    const activeCacheTotalBtn = screen.getByRole('button', { name: '概览含缓存' });
    expect(activeCacheEffectiveBtn).toHaveAttribute(
      'title',
      '概览指标使用输入 + 输出 Token；趋势与专属分析始终使用此有效口径',
    );
    expect(activeCacheTotalBtn).toHaveAttribute(
      'title',
      '仅概览指标加入缓存量；趋势与专属分析仍保持有效 Token 口径',
    );
  });
});
