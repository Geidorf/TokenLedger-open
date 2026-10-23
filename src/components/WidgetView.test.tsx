import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { QuotaProviderEnvelope, QuotaWindowSnapshot, StatsData } from '../types';
import { providerDisplayName } from '../utils/quotaOverview';
import { quotaWindowParts, selectCompanyQuotaWindows } from './QuotaPanel';
import WidgetView, { readWidgetMode } from './WidgetView';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

function buildStats(range: 'today' | 'week' | 'month', tokens: number): StatsData {
  const series = Array.from({ length: 6 }, (_, index) => ({ bucket: `b${index}`, tokens: (index + 1) * 1000, requests: 3, cost: 0.1 }));
  return {
    summary: {
      totalTokens: tokens,
      inputTokens: Math.round(tokens * 0.6),
      outputTokens: Math.round(tokens * 0.4),
      cachedTokens: 12_000,
      totalCost: 3.21,
      totalRequests: 42,
      avgTokensPerReq: 100,
    },
    tools: {},
    models: {},
    trends: [],
    heatmap: {},
    history: [],
    comparison: {
      window: {
        kind: 'dayOverDay',
        timezone: 'Asia/Shanghai',
        bucket: 'hour',
        currentStart: '2026-09-05 00:00:00',
        currentEnd: '2026-09-05 12:00:00',
        previousStart: '2026-09-04 00:00:00',
        previousEnd: '2026-09-04 12:00:00',
        alignedThrough: '2026-09-05 12:00:00',
      },
      current: { summary: { totalTokens: tokens, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 3.21, totalRequests: 42, avgTokensPerReq: 0 }, series },
      previous: { summary: { totalTokens: tokens * 2, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 6, totalRequests: 80, avgTokensPerReq: 0 }, series },
      delta: {
        tokens: { absolute: -tokens, percent: -50, direction: 'down' },
        requests: { absolute: -38, percent: -47.5, direction: 'down' },
        cost: { absolute: -2.79, percent: -46.5, direction: 'down' },
      },
    },
    meta: { contractVersion: 2, range },
  };
}

const CLAUDE_PROVIDER: QuotaProviderEnvelope = {
  schemaVersion: 1,
  providerId: 'anthropic-claude-consumer',
  displayName: 'Anthropic Claude',
  scope: 'consumer-subscription',
  mode: 'automatic',
  capability: 'plan-dependent',
  status: 'ok',
  windows: [
    {
      providerId: 'anthropic-claude-consumer',
      windowId: 'five-hour',
      windowLabel: '5-hour',
      scope: 'consumer-subscription',
      source: 'local-authorized',
      status: 'ok',
      used: 87,
      limit: 100,
      remaining: 13,
      unit: 'percent',
      windowMinutes: 300,
      resetsAt: new Date(Date.now() + 90 * 60_000).toISOString(),
      observedAt: new Date(Date.now() - 60_000).toISOString(),
      fetchedAt: new Date(Date.now() - 60_000).toISOString(),
      staleAfterSeconds: 3600,
    },
  ],
};

/** Antigravity 的一个百分比窗口：窗口名自带分组前缀（「Gemini 每周额度」），看板按前缀分组。 */
function antigravityWindow(windowId: string, windowLabel: string, used: number, windowMinutes: number): QuotaWindowSnapshot {
  return {
    providerId: 'google-antigravity-consumer',
    windowId,
    windowLabel,
    scope: 'consumer-subscription',
    source: 'local-authorized',
    status: 'ok',
    used,
    limit: 100,
    remaining: 100 - used,
    unit: 'percent',
    windowMinutes,
    // 窗口正走到一半。
    resetsAt: new Date(Date.now() + (windowMinutes / 2) * 60_000).toISOString(),
    observedAt: new Date(Date.now() - 60_000).toISOString(),
    fetchedAt: new Date(Date.now() - 60_000).toISOString(),
    staleAfterSeconds: 3600,
  };
}

/** 同一来源两个「每周」窗口（T10.190 P5）：只取短名时两行都叫「Antigravity · 每周」。 */
const ANTIGRAVITY_PROVIDER: QuotaProviderEnvelope = {
  schemaVersion: 1,
  providerId: 'google-antigravity-consumer',
  displayName: 'Antigravity',
  scope: 'consumer-subscription',
  mode: 'automatic',
  capability: 'experimental',
  status: 'ok',
  windows: [
    antigravityWindow('antigravity-gemini-weekly', 'Gemini 每周额度', 32, 10_080),
    antigravityWindow('antigravity-claude-gpt-weekly', 'Claude / GPT 每周额度', 45, 10_080),
    antigravityWindow('antigravity-gemini-five-hour', 'Gemini 5 小时额度', 18, 300),
    antigravityWindow('antigravity-claude-gpt-five-hour', 'Claude / GPT 5 小时额度', 27, 300),
  ],
};

/** 公司额度来源（与 dev mock 同形）：契约里有 Key 日额度，看板只显示今日与本月（T10.191 评审 P2-1）。 */
const COMPANY_ID = 'company-openapi-0123456789abcdef01234567';
function companyWindow(windowId: string, windowLabel: string, used: number, windowMinutes: number): QuotaWindowSnapshot {
  return {
    providerId: COMPANY_ID,
    windowId,
    windowLabel,
    scope: 'api-organization',
    source: 'official-api',
    status: 'ok',
    used,
    limit: 100,
    remaining: 100 - used,
    unit: 'percent',
    windowMinutes,
    observedAt: new Date(Date.now() - 60_000).toISOString(),
    fetchedAt: new Date(Date.now() - 60_000).toISOString(),
    staleAfterSeconds: 300,
  };
}
const COMPANY_PROVIDER: QuotaProviderEnvelope = {
  schemaVersion: 1,
  providerId: COMPANY_ID,
  displayName: '生产账号',
  scope: 'api-organization',
  mode: 'automatic',
  capability: 'plan-dependent',
  status: 'ok',
  windows: [
    companyWindow('key-daily', 'Key 今日额度', 95, 1_440),
    companyWindow('user-daily', '用户今日额度', 41, 1_440),
    companyWindow('user-monthly', '用户本月额度', 58, 43_200),
  ],
};

/** 两块挂件各存一份内容配置；测试只关心挂件读到的那几个键。 */
function widgetSettings(overrides: Record<string, unknown> = {}) {
  return {
    widget_popover_layout: 'usage',
    widget_popover_theme: 'system',
    widget_popover_range: 'today',
    widget_popover_provider: null,
    widget_desktop_layout: 'usage',
    widget_desktop_theme: 'system',
    widget_desktop_range: 'today',
    widget_desktop_provider: null,
    ...overrides,
  };
}

/** 胶囊的可见文字（读屏句另放在 sr-only 里）。 */
function chipText(container: HTMLElement): string | null | undefined {
  return container.querySelector('.wl-chip [aria-hidden="true"]')?.textContent;
}

describe('WidgetView helpers', () => {
  it('只有 URL 带 mode=desktop 才是桌面小组件，其余都是托盘弹层', () => {
    expect(readWidgetMode('?view=widget')).toBe('popover');
    expect(readWidgetMode('?view=widget&mode=desktop')).toBe('desktop');
    expect(readWidgetMode('')).toBe('popover');
  });
});

describe('WidgetView', () => {
  const listeners = new Map<string, () => void>();
  let settings: Record<string, unknown>;

  function quotaProviders(providers: QuotaProviderEnvelope[]) {
    invokeMock.mockImplementation(async (command: string, payload?: unknown) => {
      if (command === 'get_settings') return settings;
      if (command === 'get_cached_stats') return buildStats((payload as { range: 'today' }).range, 123_456);
      if (command === 'get_local_quota_providers') return providers;
      return null;
    });
  }

  beforeEach(() => {
    listeners.clear();
    settings = widgetSettings();
    listenMock.mockImplementation(async (event, callback) => {
      listeners.set(event, callback as () => void);
      return () => listeners.delete(event);
    });
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string, payload?: unknown) => {
      if (command === 'get_settings') return settings;
      if (command === 'get_cached_stats') {
        const range = (payload as { range: 'today' | 'week' | 'month' }).range;
        return buildStats(range, range === 'today' ? 123_456 : 654_321);
      }
      if (command === 'get_local_quota_providers') return [CLAUDE_PROVIDER];
      return null;
    });
  });

  it('「用量详情」：有效 Token、较昨日同期（与看板同一份同期对比）、预估费用与记录数、走势、最紧额度', async () => {
    const { container } = render(<WidgetView />);
    expect(await screen.findByText('123.5K')).toBeInTheDocument();
    expect(screen.getByText('今日 · 有效 Token')).toBeInTheDocument();
    expect(chipText(container)).toBe('−50% 较昨日同期');
    expect(screen.getByText('有效 Token较昨日同期减少 50%，绝对变化 −123.5K')).toHaveClass('sr-only');
    expect(container.querySelector('.wl-hero-cost')).toHaveTextContent('≈$3.21');
    // 账本行数叫「记录数」（GLB-02），不再写「N 次请求」（T10.190 P6）。
    expect(screen.getByText('记录数 42')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^今日有效 Token 走势：实线为今日，虚线为昨日同期/ })).toBeInTheDocument();
    const minis = await screen.findByRole('list', { name: '最紧的额度窗口' });
    // 额度一律写「可用 N%」，与看板、Android 一致（T10.190 P5）；档位字 + 重置时间。
    expect(minis.querySelector('.sr-only')?.textContent).toMatch(/^Claude · 5 小时，可用 13%，告急，1 小时 (29|30) 分后重置$/);
    expect(minis.querySelector('.wl-ring')).toHaveAttribute('data-level', 'critical');
    expect(container).not.toHaveTextContent(/剩余|请求|成本/);
    expect(invokeMock).toHaveBeenCalledWith('get_cached_stats', expect.objectContaining({ scope: 'local', range: 'today', deviceFilter: 'all_cloud' }));
  });

  it('设置里的默认范围决定打开时看哪一段，顶栏分段只是本次会话的临时覆盖', async () => {
    // 旧实现把选择写进 localStorage['tokenledger:widget-range']，两块挂件共用一个键：
    // 在托盘挂件里切到本周，桌面小组件下次打开也跟着变。现在改成各存各的默认范围。
    settings.widget_popover_range = 'week';
    render(<WidgetView />);
    expect(await screen.findByText('654.3K')).toBeInTheDocument();
    expect(screen.getByText('本周 · 有效 Token')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '本周' })).toHaveAttribute('aria-pressed', 'true');
    expect(invokeMock).not.toHaveBeenCalledWith('get_cached_stats', expect.objectContaining({ range: 'today' }));
    fireEvent.click(screen.getByRole('button', { name: '今日' }));
    expect(await screen.findByText('123.5K')).toBeInTheDocument();
    expect(window.localStorage.getItem('tokenledger:widget-range')).toBeNull();
  });

  it('改设置后不必重开窗口：settings-updated 到达即换板式', async () => {
    const { container } = render(<WidgetView />);
    await screen.findByText('123.5K');
    settings.widget_popover_layout = 'compact';
    await act(async () => listeners.get('settings-updated')?.());
    await waitFor(() => expect(container.querySelector('.widget-root')).toHaveAttribute('data-layout', 'compact'));
    expect(container.querySelector('.wl-compact-num')).toHaveTextContent('123.5K');
  });

  it('「实时路由」读脱敏的网关视图画失败切换，不读额度、不出现范围分段', async () => {
    settings.widget_popover_layout = 'routing';
    const at = new Date(Date.now() - 1_000).toISOString();
    invokeMock.mockImplementation(async (command: string, payload?: unknown) => {
      if (command === 'get_settings') return settings;
      if (command === 'get_cached_stats') return buildStats((payload as { range: 'today' }).range, 123_456);
      if (command === 'gateway_routing_feed') {
        return {
          running: true,
          decisions: [{ ts: at, requestId: 'r1', group: 'coding', chosen: 'deepseek/deepseek-chat', attempts: [
            { member: 'openai/gpt-5', outcome: 'failed', status: 429 },
            { member: 'deepseek/deepseek-chat', outcome: 'ok', status: 200 },
          ] }],
          requests: [{ ts: at, requestId: 'a2', logicalRequestId: 'r1', agent: 'codex', provider: 'deepseek', requestedModel: 'group/coding', upstreamModel: 'deepseek-chat', group: 'coding', status: 200, ok: true }],
        };
      }
      return null;
    });
    const { container } = render(<WidgetView />);
    const stage = await screen.findByRole('figure', { name: '实时路由动画' });
    expect(container.querySelector('.widget-root')).toHaveAttribute('data-layout', 'routing');
    expect(stage.querySelector('.rs-tag')).toHaveTextContent('429');
    expect(screen.getByText('在途 0 · 已改道 1 · 失败 0')).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('gateway_routing_feed', { limit: 30 });
    expect(invokeMock).not.toHaveBeenCalledWith('get_local_quota_providers');
    expect(invokeMock.mock.calls.some(([command]) => command === 'gateway_recent_route_decisions' || command === 'gateway_status')).toBe(false);
    expect(screen.queryByRole('button', { name: '本周' })).not.toBeInTheDocument();
  });

  it('「实时路由」网关没运行时只给空态，不画动画', async () => {
    settings.widget_popover_layout = 'routing';
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_settings') return settings;
      if (command === 'gateway_routing_feed') return { running: false, decisions: [], requests: [] };
      return null;
    });
    const { container } = render(<WidgetView />);
    expect(await screen.findByText(/暂无实时路由数据/)).toBeInTheDocument();
    expect(container.querySelector('.rs-packet')).toBeNull();
  });

  it('换到别的板式就不再轮询网关', async () => {
    const { container } = render(<WidgetView />);
    await screen.findByText('123.5K');
    expect(container.querySelector('.wl-routing')).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith('gateway_routing_feed', expect.anything());
  });

  it('「单行消耗」只留有效 Token 与预估费用，也不去读额度（T10.154 D51）', async () => {
    settings.widget_popover_layout = 'compact';
    const { container } = render(<WidgetView />);
    await screen.findByText('123.5K');
    expect(container.querySelector('.widget-root')).toHaveAttribute('data-layout', 'compact');
    expect(container.querySelector('.wl-compact-cost')).toHaveTextContent('≈$3.21');
    // 预估费用在这一板式里是主角，只出现一次。
    expect(screen.getAllByText('预估费用')).toHaveLength(1);
    expect(chipText(container)).toBe('−50%');
    expect(screen.queryByRole('img', { name: /走势/ })).not.toBeInTheDocument();
    expect(container.querySelector('.wl-ring, .wl-legend, .wl-kv')).toBeNull();
    expect(invokeMock.mock.calls.some(([command]) => command === 'get_local_quota_providers')).toBe(false);
  });

  it('「额度总览」画窗口圆环，并收起对它没有意义的范围分段', async () => {
    settings.widget_popover_layout = 'quota';
    const { container } = render(<WidgetView />);
    const list = await screen.findByRole('list', { name: '额度窗口，按吃紧程度' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(container.querySelectorAll('.wl-ring[data-size="64"]')).toHaveLength(1);
    expect(screen.queryByRole('group', { name: '统计范围' })).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /走势/ })).not.toBeInTheDocument();
    // 顶栏的四个图标照常在。
    expect(screen.getByRole('button', { name: '刷新扫描' })).toBeInTheDocument();
  });

  it('「额度与用量」：左边最紧窗口的 92px 圆环，右边有效 Token 与预估费用；范围分段仍在', async () => {
    settings.widget_popover_layout = 'combo';
    const { container } = render(<WidgetView />);
    await screen.findByText('123.5K');
    await waitFor(() => expect(container.querySelector('.wl-ring[data-size="92"]')).not.toBeNull());
    expect(container.querySelector('.wl-combo-ring .sr-only')?.textContent).toMatch(/^Claude · 5 小时，可用 13%，告急，/);
    expect(container.querySelector('.wl-combo-cost')).toHaveTextContent('≈$3.21');
    expect(screen.getByRole('group', { name: '统计范围' })).toBeInTheDocument();
  });

  it('额度窗口名带分组，与看板同名：同一来源的两个「每周」窗口分得开（T10.190 P5）', async () => {
    settings.widget_popover_layout = 'quota';
    quotaProviders([ANTIGRAVITY_PROVIDER]);
    render(<WidgetView />);
    const list = await screen.findByRole('list', { name: '额度窗口，按吃紧程度' });
    const names = within(list).getAllByRole('listitem').map((item) => item.querySelector('.sr-only')?.textContent?.split('，')[0]);
    // 看板把这四个窗口分成「Antigravity · Gemini」「Antigravity · Claude / GPT」两张卡，卡内写「每周」「5 小时」。
    for (const window of ANTIGRAVITY_PROVIDER.windows) {
      const { groupLabel, label } = quotaWindowParts(window);
      expect(names).toContain(`${providerDisplayName(ANTIGRAVITY_PROVIDER)} · ${groupLabel} ${label}`);
    }
    expect(names).toContain('Antigravity · Gemini 每周');
    expect(names).toContain('Antigravity · Claude / GPT 每周');
    expect(new Set(names).size).toBe(names.length);
  });

  it('公司额度来源只画看板显示的「今日」「本月」，窗口数与看板一致（R-52 P2-1）', async () => {
    settings.widget_popover_layout = 'quota';
    quotaProviders([CLAUDE_PROVIDER, COMPANY_PROVIDER]);
    const { container } = render(<WidgetView />);
    const list = await screen.findByRole('list', { name: '额度窗口，按吃紧程度' });
    const expected = selectCompanyQuotaWindows(COMPANY_PROVIDER.windows).length + CLAUDE_PROVIDER.windows.length;
    expect(within(list).getAllByRole('listitem')).toHaveLength(expected);
    expect(container.querySelector('.wl-title .wl-meta')?.textContent).toMatch(new RegExp(`^${expected} 个窗口 · `));
    expect(list).toHaveTextContent('生产账号 · 今日，可用 59%，充足');
    expect(list).toHaveTextContent('生产账号 · 本月，可用 42%，偏紧');
    // Key 日额度最吃紧（可用 5%），漏过筛选就会顶到第一个圆环上。
    expect(container).not.toHaveTextContent('Key');
    expect(list.querySelector('.sr-only')?.textContent).toMatch(/^Claude · 5 小时，可用 13%/);
  });

  it('「额度与用量」的「另有 N 个窗口」写在右栏底部；看全的提示给读屏，不只放在 title（R-52 P3-1）', async () => {
    settings.widget_popover_layout = 'combo';
    quotaProviders([CLAUDE_PROVIDER, ANTIGRAVITY_PROVIDER]);
    const { container } = render(<WidgetView />);
    await waitFor(() => expect(container.querySelector('.wl-combo-meta')).toHaveTextContent('另有 4 个窗口'));
    const meta = container.querySelector('.wl-combo-meta') as HTMLElement;
    expect(within(meta).getByText('，换「额度总览」板式可看全部')).toHaveClass('sr-only');
    expect(container.querySelector('[title*="看全"]')).toBeNull();
    // 「用量详情」的迷你圆环只画最紧的两个，不写「另有」。
    settings.widget_popover_layout = 'usage';
    await act(async () => listeners.get('settings-updated')?.());
    await waitFor(() => expect(container.querySelector('.widget-root')).toHaveAttribute('data-layout', 'usage'));
    expect(screen.queryByText(/另有 \d+ 个窗口/)).not.toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: '最紧的额度窗口' })).getAllByRole('listitem')).toHaveLength(2);
  });

  it.each(['usage', 'combo', 'quota', 'compact'] as const)('「%s」板式不再出现「请求」「剩余」「成本」（GLB-02、T10.190 P6）', async (layout) => {
    settings.widget_popover_layout = layout;
    const { container } = render(<WidgetView />);
    await waitFor(() => expect(container.querySelector('.widget-root')).toHaveAttribute('data-layout', layout));
    if (layout === 'compact') await screen.findByText('123.5K');
    else await waitFor(() => expect(container).toHaveTextContent('可用 13%'));
    expect(container).not.toHaveTextContent(/请求|剩余|成本/);
  });

  it.each(['usage', 'combo', 'compact'] as const)('「%s」板式读不到费用时不画 $0：契约拒收整份统计，写读取失败与「—」', async (layout) => {
    settings.widget_popover_layout = layout;
    invokeMock.mockImplementation(async (command: string, payload?: unknown) => {
      if (command === 'get_settings') return settings;
      if (command === 'get_cached_stats') {
        const stats = buildStats((payload as { range: 'today' }).range, 123_456);
        return { ...stats, summary: { ...stats.summary, totalCost: null } };
      }
      if (command === 'get_local_quota_providers') return [];
      return null;
    });
    const { container } = render(<WidgetView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('读取失败，请重试');
    expect(container).not.toHaveTextContent('summary.totalCost');
    expect(container).not.toHaveTextContent('$0');
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('钉住的来源读不到额度时直说读不到，不改显示别人的额度', async () => {
    settings.widget_popover_provider = 'openai-codex-local';
    const { container } = render(<WidgetView />);
    await screen.findByText('123.5K');
    expect(await screen.findByText(/没有可读的额度窗口/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: '最紧的额度窗口' })).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent('Claude');
    fireEvent.click(screen.getByRole('button', { name: '去设置换来源' }));
    expect(invokeMock).toHaveBeenCalledWith('open_main_settings');
  });

  it('挂件的主题设置压过跟随系统的主窗口主题，卡片按它取深浅色', async () => {
    settings.widget_popover_theme = 'light';
    const { container } = render(<WidgetView />);
    await screen.findByText('123.5K');
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'));
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(container.querySelector('.widget-root')).toHaveAttribute('data-card-theme', 'light');
    // 主窗口改主题会写 localStorage 并广播 storage 事件，挂件必须改回自己的选择。
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'tokenledger:theme', newValue: 'dark' }));
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(container.querySelector('.widget-root')).toHaveAttribute('data-card-theme', 'light');
  });

  it('托盘挂件顶栏：范围分段 + 刷新、打开主窗口、设置、收起四个图标，各触发各的命令', async () => {
    const { container } = render(<WidgetView />);
    await screen.findByText('123.5K');
    const bar = container.querySelector('.wl-bar') as HTMLElement;
    expect(within(bar).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual([
      '今日', '本周', '本月', '刷新扫描', '打开主窗口', '打开设置', '隐藏托盘挂件',
    ]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '刷新扫描' }));
    });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('refresh_scan'));
    fireEvent.click(screen.getByRole('button', { name: '打开主窗口' }));
    expect(invokeMock).toHaveBeenCalledWith('focus_main_window');
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }));
    expect(invokeMock).toHaveBeenCalledWith('open_main_settings');
    fireEvent.click(screen.getByRole('button', { name: '隐藏托盘挂件' }));
    expect(invokeMock).toHaveBeenCalledWith('hide_widget_window');
    expect(screen.queryByRole('button', { name: '从桌面移除' })).not.toBeInTheDocument();
    // 托盘挂件没有悬停工具条。
    expect(container.querySelector('.wl-toolbar')).toBeNull();
  });

  it('托盘挂件全程可用键盘：每个按钮都能聚焦，没有被 inert、aria-hidden 或 tabindex=-1 挡住', async () => {
    quotaProviders([]);
    const { container } = render(<WidgetView />);
    await screen.findByRole('button', { name: '去主窗口授权来源' });
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons).toHaveLength(8);
    for (const button of buttons) {
      expect(button.closest('[inert], [aria-hidden="true"]')).toBeNull();
      expect(button).not.toHaveAttribute('tabindex', '-1');
      button.focus();
      expect(document.activeElement).toBe(button);
    }
  });

  it('托盘弹层把指针进出上报给原生侧，供悬停显隐状态机使用', async () => {
    const { container } = render(<WidgetView />);
    await screen.findByText('123.5K');
    const root = container.querySelector('.widget-root') as HTMLElement;
    expect(root).toHaveAttribute('data-mode', 'popover');
    expect(document.body.className).toBe('widget-window');
    fireEvent.mouseEnter(root);
    expect(invokeMock).toHaveBeenCalledWith('widget_pointer_hover', { inside: true });
    fireEvent.mouseLeave(root);
    expect(invokeMock).toHaveBeenCalledWith('widget_pointer_hover', { inside: false });
  });

  it('只有桌面小组件是拖动区：整张卡都能拖，按钮自己挡住拖动；托盘弹层不给可拖动的暗示', async () => {
    // 托盘弹层每次显示都会贴回托盘锚点，指针离开还会自动收起，
    // 拖出来的位置既留不住也待不住（T10.128 P2）。
    const popover = render(<WidgetView />);
    await screen.findByText('123.5K');
    expect(popover.container.querySelectorAll('[data-tauri-drag-region]')).toHaveLength(0);
    popover.unmount();

    const desktop = render(<WidgetView mode="desktop" />);
    await screen.findByText('123.5K');
    // `deep`：子元素也算拖动区（Tauri 2 drag.js），可点击元素（按钮）不拖。
    expect(desktop.container.querySelector('.widget-root')).toHaveAttribute('data-tauri-drag-region', 'deep');
    expect(desktop.container.querySelectorAll('[data-tauri-drag-region]')).toHaveLength(1);
    expect([...desktop.container.querySelectorAll('.wl-toolbar > *')].every((node) => node.tagName === 'BUTTON')).toBe(true);
  });

  it('桌面小组件平时没有任何按钮、也不可聚焦；指针移入才淡入工具条，移出收起（U-18）', async () => {
    const { container } = render(<WidgetView mode="desktop" />);
    await screen.findByText('123.5K');
    const root = container.querySelector('.widget-root') as HTMLElement;
    const toolbar = container.querySelector('.wl-toolbar') as HTMLElement;
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(toolbar).toHaveAttribute('data-shown', 'false');
    expect(toolbar).toHaveAttribute('aria-hidden', 'true');
    expect(toolbar).toHaveAttribute('inert');
    expect(root).toHaveAttribute('data-toolbar', 'hidden');
    expect(container.querySelector('[tabindex]')).toBeNull();
    expect([...container.querySelectorAll('button')].every((button) => button.closest('[inert]'))).toBe(true);

    fireEvent.mouseEnter(root);
    expect(toolbar).toHaveAttribute('data-shown', 'true');
    expect(toolbar).not.toHaveAttribute('inert');
    expect(toolbar).not.toHaveAttribute('aria-hidden');
    expect(root).toHaveAttribute('data-toolbar', 'shown');
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      '刷新扫描', '打开主窗口', '打开设置', '从桌面移除',
    ]);

    fireEvent.mouseLeave(root);
    expect(toolbar).toHaveAttribute('data-shown', 'false');
    expect(root).toHaveAttribute('data-toolbar', 'hidden');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it.each([
    ['usage', 'top'],
    ['quota', 'top'],
    ['compact', 'top'],
    ['combo', 'bottom'],
  ] as const)('「%s」的工具条盖在「更新于」那一行上（%s），不盖大数字', async (layout, at) => {
    settings.widget_desktop_layout = layout;
    const { container } = render(<WidgetView mode="desktop" />);
    await waitFor(() => expect(container.querySelector('.widget-root')).toHaveAttribute('data-layout', layout));
    if (layout === 'quota') await screen.findByRole('list', { name: '额度窗口，按吃紧程度' });
    else await screen.findByText('123.5K');
    expect(container.querySelector('.wl-toolbar')).toHaveAttribute('data-at', at);
    const under = [...container.querySelectorAll('.wl-under-toolbar')];
    expect(under).toHaveLength(1);
    expect(under[0].querySelector('.wl-num')).toBeNull();
    expect(under[0]).not.toHaveClass('wl-num');
    // 工具条紧跟在它盖住的那一行之后：DOM 顺序即读屏顺序。
    const flow = [...container.querySelectorAll('.wl-under-toolbar, .wl-toolbar')];
    expect(flow.map((node) => node.classList.contains('wl-toolbar'))).toEqual([false, true]);
  });

  it('桌面小组件读自己那份配置：从桌面移除、打开设置，不上报托盘悬停', async () => {
    settings.widget_desktop_layout = 'quota';
    const { container } = render(<WidgetView mode="desktop" />);
    const root = container.querySelector('.widget-root') as HTMLElement;
    expect(await screen.findByRole('list', { name: '额度窗口，按吃紧程度' })).toBeInTheDocument();
    expect(root).toHaveAttribute('data-mode', 'desktop');
    // 托盘那份仍是 usage：两块挂件的板式互不影响。
    expect(root).toHaveAttribute('data-layout', 'quota');
    expect(document.body.className).toContain('widget-desktop');
    fireEvent.mouseEnter(root);
    expect(invokeMock).not.toHaveBeenCalledWith('widget_pointer_hover', expect.anything());
    expect(screen.queryByRole('button', { name: '隐藏托盘挂件' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '从桌面移除' }));
    expect(invokeMock).toHaveBeenCalledWith('set_desktop_widget_enabled', { enabled: false });
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }));
    expect(invokeMock).toHaveBeenCalledWith('open_main_settings');
    fireEvent.mouseLeave(root);
    expect(invokeMock).not.toHaveBeenCalledWith('widget_pointer_hover', expect.anything());
  });

  it('没有可读额度时：托盘挂件给去主窗口授权的入口，桌面小组件只写一句、不放按钮', async () => {
    quotaProviders([]);
    const popover = render(<WidgetView />);
    fireEvent.click(await screen.findByRole('button', { name: '去主窗口授权来源' }));
    expect(invokeMock).toHaveBeenCalledWith('focus_main_window');
    popover.unmount();
    const desktop = render(<WidgetView mode="desktop" />);
    expect(await screen.findByText('还没有可展示的订阅额度。')).toBeInTheDocument();
    expect(desktop.container.querySelector('.wl-link')).toBeNull();
  });

  it('额度整次读取失败（invoke 被拒绝）：写「不可用」，不是「没有来源」，也没有「去主窗口授权来源」按钮（P2-1）', async () => {
    invokeMock.mockImplementation(async (command: string, payload?: unknown) => {
      if (command === 'get_settings') return settings;
      if (command === 'get_cached_stats') return buildStats((payload as { range: 'today' }).range, 123_456);
      if (command === 'get_local_quota_providers') throw new Error('额度来源超时');
      return null;
    });
    render(<WidgetView />);
    expect(await screen.findByText('额度读取失败，不可用。')).toBeInTheDocument();
    expect(screen.queryByText('还没有可展示的订阅额度。')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '去主窗口授权来源' })).not.toBeInTheDocument();
  });

  it('慢额度不会阻塞本机统计，切换范围时不显示旧数字', async () => {
    let resolveQuota: (value: unknown[]) => void = () => undefined;
    let resolveWeek: (value: StatsData) => void = () => undefined;
    invokeMock.mockImplementation((command: string, payload?: unknown) => {
      if (command === 'get_settings') return Promise.resolve(settings);
      if (command === 'get_local_quota_providers') return new Promise((resolve) => { resolveQuota = resolve; });
      if (command === 'get_cached_stats') {
        if ((payload as { range: string }).range === 'week') return new Promise((resolve) => { resolveWeek = resolve; });
        return Promise.resolve(buildStats('today', 123456));
      }
      return Promise.resolve(null);
    });
    render(<WidgetView />);
    await screen.findByText('123.5K');
    expect(screen.getByRole('status')).toHaveTextContent('正在读取额度…');
    expect(screen.queryByRole('button', { name: '去主窗口授权来源' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '本周' }));
    expect(screen.queryByText('123.5K')).not.toBeInTheDocument();
    await act(async () => resolveWeek(buildStats('week', 654321)));
    expect(await screen.findByText('654.3K')).toBeInTheDocument();
    await act(async () => resolveQuota([]));
    expect(screen.queryByText('正在读取额度…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去主窗口授权来源' })).toBeInTheDocument();
  });

  it('Escape 关闭弹层，但不移除桌面小组件', async () => {
    const { container, unmount } = render(<WidgetView />);
    await screen.findByText('123.5K');
    fireEvent.keyDown(container.querySelector('.widget-root')!, { key: 'Escape' });
    expect(invokeMock).toHaveBeenCalledWith('hide_widget_window');
    unmount();
    invokeMock.mockClear();
    const desktop = render(<WidgetView mode="desktop" />);
    await screen.findByText('123.5K');
    fireEvent.keyDown(desktop.container.querySelector('.widget-root')!, { key: 'Escape' });
    expect(invokeMock).not.toHaveBeenCalledWith('set_desktop_widget_enabled', expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith('hide_widget_window');
  });

  it('统计读取失败时保留错误提示而不是空白，数字位写「—」', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_settings') return settings;
      if (command === 'get_cached_stats') throw new Error('数据库忙');
      return [];
    });
    render(<WidgetView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('读取失败，请重试');
    expect(document.body).not.toHaveTextContent('数据库忙');
    expect(document.body).not.toHaveTextContent('旧快照');
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(document.body).not.toHaveTextContent('$0');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['usage', 'combo', 'quota', 'compact'] as const)('「%s」读取失败保留同范围快照和上次成功读取时间，重试成功才清错', async (layout) => {
    settings.widget_popover_layout = layout;
    const firstRead = new Date('2026-10-01T20:12:00Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(firstRead);
    let fail = false;
    let resolveRetry: ((value: StatsData) => void) | undefined;
    let retry = false;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_settings') return settings;
      if (command === 'get_local_quota_providers') return [];
      if (command === 'get_cached_stats') {
        if (retry) return new Promise((resolve) => { resolveRetry = resolve; });
        if (fail) throw new Error('SQLITE_BUSY /private/ledger.db summary.totalCost');
        return { ...buildStats('today', 123_456), meta: { range: 'today', generatedAt: '2020-01-01T00:00:00Z' } };
      }
      return null;
    });
    const { container } = render(<WidgetView />);
    await waitFor(() => expect(container).toHaveTextContent('更新于'));
    const initialToken = container.querySelector('.wl-hero-num, .wl-combo-num, .wl-compact-num')?.textContent;
    fail = true;
    vi.setSystemTime(new Date('2026-10-02T21:25:00Z'));
    act(() => listeners.get('stats-updated')?.());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('失败 · 旧快照');
    const readLabel = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(firstRead);
    expect(alert.querySelector('[aria-hidden="true"]')).toHaveTextContent(readLabel);
    expect(alert).toHaveAttribute('title', expect.stringContaining(firstRead.toLocaleString('zh-CN')));
    expect(alert.querySelector('.sr-only')).toHaveTextContent('上次成功读取时间');
    expect(alert.querySelector('.sr-only')).toHaveTextContent('本机读取时间');
    expect(alert).not.toHaveTextContent('2020');
    expect(container).not.toHaveTextContent('SQLITE_BUSY');
    expect(container).not.toHaveTextContent('/private/ledger.db');
    if (initialToken) expect(container.querySelector('.wl-hero-num, .wl-combo-num, .wl-compact-num')).toHaveTextContent(initialToken);
    retry = true;
    fireEvent.click(screen.getByRole('button', { name: '刷新扫描' }));
    await waitFor(() => expect(resolveRetry).toBeDefined());
    expect(screen.getByRole('alert')).toHaveAttribute('title', expect.stringContaining(firstRead.toLocaleString('zh-CN')));
    const secondRead = new Date('2026-10-02T22:30:00Z');
    vi.setSystemTime(secondRead);
    await act(async () => resolveRetry?.(buildStats('today', 654_321)));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(secondRead);
    expect(container).toHaveTextContent(`更新于 ${clock}`);
    if (initialToken) expect(container.querySelector('.wl-hero-num, .wl-combo-num, .wl-compact-num')).toHaveTextContent('654.3K');
  });

  it('切换范围立即隐藏前一范围的错误和快照，目标范围失败也不借用旧值', async () => {
    let failToday = false;
    let returningToday = false;
    let rejectWeek: ((reason: Error) => void) | undefined;
    invokeMock.mockImplementation(async (command: string, payload?: unknown) => {
      if (command === 'get_settings') return settings;
      if (command === 'get_cached_stats') {
        if ((payload as { range: string }).range === 'week') return new Promise((_, reject) => { rejectWeek = reject; });
        if (returningToday) return new Promise(() => undefined);
        if (failToday) throw new Error('today failed');
        return buildStats('today', 123_456);
      }
      return [];
    });
    render(<WidgetView />);
    await screen.findByText('123.5K');
    failToday = true;
    act(() => listeners.get('stats-updated')?.());
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: '本周' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('123.5K')).not.toBeInTheDocument();
    expect(screen.getByText('正在读取…')).toBeInTheDocument();
    await act(async () => rejectWeek?.(new Error('week failed')));
    expect(screen.getByRole('alert')).toHaveTextContent('读取失败，请重试');
    expect(document.body).not.toHaveTextContent('旧快照');
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    // 回到仍保留的今日快照，也不能因本周错误覆盖了状态而伪装成新鲜。
    returningToday = true;
    fireEvent.click(screen.getByRole('button', { name: '今日' }));
    expect(screen.getByText('123.5K')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('失败 · 旧快照');
  });

  it('前一范围迟到的读取失败不覆盖新范围成功值', async () => {
    let rejectToday: ((reason: Error) => void) | undefined;
    invokeMock.mockImplementation(async (command: string, payload?: unknown) => {
      if (command === 'get_settings') return settings;
      if (command === 'get_cached_stats') {
        if ((payload as { range: string }).range === 'today') return new Promise((_, reject) => { rejectToday = reject; });
        return buildStats('week', 654_321);
      }
      return [];
    });
    render(<WidgetView />);
    await waitFor(() => expect(rejectToday).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: '本周' }));
    await screen.findByText('654.3K');
    await act(async () => rejectToday?.(new Error('late today failure')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('654.3K')).toBeInTheDocument();
  });

  it('扫描失败不暴露技术异常，保留旧快照，重试成功后恢复', async () => {
    let failScan = true;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_settings') return settings;
      if (command === 'get_cached_stats') return buildStats('today', 123_456);
      if (command === 'refresh_scan' && failScan) throw new Error('EACCES /private/logs');
      return [];
    });
    render(<WidgetView />);
    await screen.findByText('123.5K');
    fireEvent.click(screen.getByRole('button', { name: '刷新扫描' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('失败 · 旧快照');
    expect(alert).toHaveAttribute('title', expect.stringContaining('扫描失败'));
    expect(document.body).not.toHaveTextContent('EACCES');
    expect(document.body).not.toHaveTextContent('/private/logs');
    expect(screen.getByText('123.5K')).toBeInTheDocument();
    failScan = false;
    fireEvent.click(screen.getByRole('button', { name: '刷新扫描' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it.each(['range', 'same-range'] as const)('迟到扫描失败不覆盖后来的%s读取成功状态', async (change) => {
    let rejectScan: ((reason: Error) => void) | undefined;
    invokeMock.mockImplementation(async (command: string, payload?: unknown) => {
      if (command === 'get_settings') return settings;
      if (command === 'get_cached_stats') return buildStats((payload as { range: 'today' | 'week' }).range, 123_456);
      if (command === 'refresh_scan') return new Promise((_, reject) => { rejectScan = reject; });
      return [];
    });
    render(<WidgetView />);
    await screen.findByText('123.5K');
    fireEvent.click(screen.getByRole('button', { name: '刷新扫描' }));
    if (change === 'range') fireEvent.click(screen.getByRole('button', { name: '本周' }));
    else act(() => listeners.get('stats-updated')?.());
    await waitFor(() => expect(invokeMock.mock.calls.filter(([command]) => command === 'get_cached_stats')).toHaveLength(2));
    await screen.findByText('123.5K');
    await act(async () => rejectScan?.(new Error('late scan failure')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('设置读不到也要显示默认板式，不能整块空白', async () => {
    invokeMock.mockImplementation(async (command: string, payload?: unknown) => {
      if (command === 'get_settings') throw new Error('设置文件损坏');
      if (command === 'get_cached_stats') return buildStats((payload as { range: 'today' }).range, 123_456);
      return [];
    });
    render(<WidgetView />);
    expect(await screen.findByText('123.5K')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '今日' })).toHaveAttribute('aria-pressed', 'true');
  });
});
