import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatMs, formatTps, RequestLogPage, TAIL_INTERVAL_MS, toQuery } from './RequestLogPage';
import { groupRecords, mockRequestLog } from './requestLogMock';
import type { LedgerRecord, RequestLogQuery, RouteDecision } from './types';
import * as api from './api';
import { contentSamplingApi } from './contentSamplingApi';

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, requestLog: vi.fn(), exportRequestLog: vi.fn(), providerHealth: vi.fn() };
});
vi.mock('./contentSamplingApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./contentSamplingApi')>();
  return {
    ...actual,
    contentSamplingApi: { status: vi.fn(), set: vi.fn(), read: vi.fn(), remove: vi.fn() },
  };
});

function health(provider: string, status: 'healthy' | 'degraded' | 'down' | 'idle') {
  const stats = { requests: 10, ok: 7, successRate: 0.7, p50Ms: 400, p95Ms: 2000, rateLimited: 3, skipped: 0, codes: [], statuses: [], lastOkAt: null, lastFailureAt: null };
  return { provider, status, reasons: ['rate_limited'], stats, models: [], buckets: [], recentFailures: [], cooling: [] };
}

const NOW = Date.parse('2026-10-24T02:00:00Z');
const base = { agent: 'codex', session: 's1', endpoint: '/v1/responses', requestedModel: 'group/coding', wire: 'chat', stream: true, cacheRead: 0, cacheWrite: 0, group: 'coding' };
const records: LedgerRecord[] = [
  { ...base, ts: '2026-10-24T01:59:01Z', requestId: 'a1', logicalRequestId: 'L1', provider: 'openai', upstreamModel: 'gpt-5', member: 'openai/gpt-5', status: 429, ok: false, input: 0, output: 0, latencyMs: 1000, error: '上游返回 429' },
  { ...base, ts: '2026-10-24T01:59:02Z', requestId: 'a2', logicalRequestId: 'L1', provider: 'deepseek', upstreamModel: 'deepseek-chat', member: 'deepseek/deepseek-chat', status: 200, ok: true, input: 1000, output: 500, latencyMs: 1000, firstTokenMs: 200,
    context: { systemBytes: 100, toolsBytes: 300, historyBytes: 600, toolResultsBytes: 0, attachmentsBytes: 0, messages: 4, toolResults: 0, attachments: 0 } },
  { ...base, ts: '2026-10-24T01:30:00Z', requestId: 'b1', logicalRequestId: 'L2', agent: 'opencode', requestedModel: 'deepseek/deepseek-chat', group: null, provider: 'deepseek', upstreamModel: 'deepseek-chat', status: 200, ok: true, input: 10, output: 20, latencyMs: 400 },
];
const decisions: RouteDecision[] = [{
  ts: '2026-10-24T01:59:02Z', requestId: 'L1', group: 'coding', reason: 'failover', detail: '按顺序', chosen: 'deepseek/deepseek-chat',
  attempts: [{ member: 'openai/gpt-5', outcome: 'failed', status: 429 }, { member: 'deepseek/deepseek-chat', outcome: 'ok', status: 200 }],
  trace: [
    { member: 'openai/gpt-5', rank: 0, verdict: 'failed', reasons: ['strategy_first', 'rate_limited'], detail: '上游返回 429' },
    { member: 'deepseek/deepseek-chat', rank: 1, verdict: 'chosen', reasons: ['fallback', 'answered'] },
  ],
}];

describe('请求日志的分组与格式', () => {
  it('同一逻辑请求的尝试合成一条，首字耗时含前面的重试', () => {
    const [l1, l2] = groupRecords(records, decisions);
    expect(l1.id).toBe('L1');
    expect([l1.retries, l1.switched, l1.status, l1.latencyMs, l1.firstTokenMs]).toEqual([1, true, 200, 2000, 1200]);
    expect(l1.outputTps).toBe(625);
    expect(l1.decision?.chosen).toBe('deepseek/deepseek-chat');
    expect(l2.retries).toBe(0);
  });

  it('筛选映射到查询参数', () => {
    const query = toQuery({ range: '1h', agent: 'codex', provider: '', model: '', status: 'retried', latency: 'gt10', search: '  429 ' }, 50, NOW);
    expect(query).toMatchObject({ since: '2026-10-24T01:00:00.000Z', agent: 'codex', provider: null, status: 'retried', minLatencyMs: 10_000, maxLatencyMs: null, search: '429', offset: 50, limit: 50 });
    expect(toQuery({ range: 'all', agent: '', provider: '', model: '', status: '', latency: '', search: '' }, 0, NOW).since).toBeNull();
    expect([formatMs(850), formatMs(1234), formatMs(42_000), formatMs(null)]).toEqual(['850 ms', '1.23 s', '42.0 s', '—']);
    expect([formatTps(625), formatTps(4.25), formatTps(0)]).toEqual(['625 tok/s', '4.3 tok/s', '—']);
  });
});

describe('RequestLogPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.requestLog).mockImplementation(async (query: RequestLogQuery) => mockRequestLog(records, decisions, { ...query, since: null }));
    vi.mocked(api.providerHealth).mockResolvedValue({ generatedAt: '2026-10-24T02:00:00Z', windowHours: 24, providers: [health('openai', 'degraded')] });
    vi.mocked(api.exportRequestLog).mockResolvedValue({ message: '已导出 2 条请求', path: '/data/tokenledger_gateway_requests.csv' });
    vi.mocked(contentSamplingApi.status).mockResolvedValue({ mode: 'off', remaining: null, expiresAt: null, agent: null, group: null, failuresOnly: false, sampleIds: [], storedCount: 0, storedBytes: 0, error: null });
  });
  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState(null, '', '/');
  });

  it('切换过的请求标出切换，展开后列出尝试顺序、解释链、Token 与 Context', async () => {
    render(<RequestLogPage />);
    const table = await screen.findByRole('table', { name: '网关请求日志' });
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('切换 1');
    expect(rows[1]).toHaveTextContent('备选');
    expect(rows[1]).toHaveTextContent('625 tok/s');
    fireEvent.click(within(rows[1]).getByRole('button', { name: /展开/ }));
    const attempts = within(screen.getByRole('region', { name: '尝试顺序' })).getAllByRole('listitem');
    expect(attempts[0]).toHaveTextContent('openai/gpt-5');
    expect(attempts[0]).toHaveTextContent('429 · 失败已切换');
    expect(attempts[1]).toHaveTextContent('首字 200 ms');
    // 尝试行旁带上该供应商当前健康度；没有健康数据的供应商不显示。
    expect(within(attempts[0]).getByRole('img', { name: '健康度：降级' })).toBeInTheDocument();
    expect(within(attempts[1]).queryByRole('img')).toBeNull();
    const trace = within(screen.getByRole('list', { name: 'group/coding 成员决策' })).getAllByRole('listitem');
    expect(trace[0]).toHaveTextContent('限流');
    expect(screen.getByRole('list', { name: 'Context 构成' })).toHaveTextContent('对话历史 60%');
    expect(screen.getByRole('region', { name: 'Token 与费用' })).toHaveTextContent('1.20 s');
  });

  it('筛选与搜索带进查询，搜索防抖', async () => {
    render(<RequestLogPage />);
    await screen.findByRole('table', { name: '网关请求日志' });
    fireEvent.change(screen.getByRole('combobox', { name: '状态' }), { target: { value: 'retried' } });
    await waitFor(() => expect(api.requestLog).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'retried', offset: 0 })));
    fireEvent.change(screen.getByRole('combobox', { name: '客户端或 Agent' }), { target: { value: 'opencode' } });
    expect(await screen.findByText('没有符合条件的请求')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '清空筛选' }));
    fireEvent.change(screen.getByRole('textbox', { name: '搜索请求日志' }), { target: { value: 'L2' } });
    await waitFor(() => expect(api.requestLog).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'L2' })));
    await waitFor(() => expect(within(screen.getByRole('table', { name: '网关请求日志' })).getAllByRole('row')).toHaveLength(2));
  });

  it('筛选变了以后，较慢的旧查询结果不会覆盖新结果', async () => {
    let releaseFirst: (() => void) | undefined;
    vi.mocked(api.requestLog).mockImplementationOnce((query: RequestLogQuery) => new Promise((resolve) => {
      releaseFirst = () => resolve(mockRequestLog(records, decisions, { ...query, since: null }));
    }));
    render(<RequestLogPage />);
    await waitFor(() => expect(releaseFirst).toBeDefined());
    fireEvent.change(screen.getByRole('combobox', { name: '状态' }), { target: { value: 'retried' } });
    await waitFor(() => expect(within(screen.getByRole('table', { name: '网关请求日志' })).getAllByRole('row')).toHaveLength(2));
    await act(async () => { releaseFirst?.(); });
    expect(within(screen.getByRole('table', { name: '网关请求日志' })).getAllByRole('row')).toHaveLength(2);
  });

  it('实时尾随按间隔重新读取，窗口隐藏时跳过', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<RequestLogPage />);
    await screen.findByRole('table', { name: '网关请求日志' });
    fireEvent.click(screen.getByRole('button', { name: '实时尾随' }));
    const before = vi.mocked(api.requestLog).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(TAIL_INTERVAL_MS); });
    expect(vi.mocked(api.requestLog).mock.calls.length).toBeGreaterThan(before);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const hidden = vi.mocked(api.requestLog).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(TAIL_INTERVAL_MS * 2); });
    expect(vi.mocked(api.requestLog).mock.calls.length).toBe(hidden);
    visibility.mockRestore();
    expect(screen.getByRole('button', { name: '尾随中' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('上一次读取还没返回时，尾随不再发起新的读取', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<RequestLogPage />);
    await screen.findByRole('table', { name: '网关请求日志' });
    let release: (() => void) | undefined;
    vi.mocked(api.requestLog).mockImplementationOnce((query: RequestLogQuery) => new Promise((resolve) => {
      release = () => resolve(mockRequestLog(records, decisions, { ...query, since: null }));
    }));
    fireEvent.click(screen.getByRole('button', { name: '实时尾随' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(TAIL_INTERVAL_MS); });
    expect(release).toBeDefined();
    const pending = vi.mocked(api.requestLog).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(TAIL_INTERVAL_MS * 3); });
    expect(vi.mocked(api.requestLog).mock.calls.length).toBe(pending);
    await act(async () => { release?.(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(TAIL_INTERVAL_MS); });
    expect(vi.mocked(api.requestLog).mock.calls.length).toBeGreaterThan(pending);
    expect(within(screen.getByRole('table', { name: '网关请求日志' })).getAllByRole('row')).toHaveLength(3);
  });

  it('导出用当前筛选、不带分页，并提示文件位置', async () => {
    const onNotify = vi.fn();
    render(<RequestLogPage onNotify={onNotify} />);
    await screen.findByRole('table', { name: '网关请求日志' });
    const exportButton = screen.getByRole('button', { name: '导出 CSV' });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith('success', '已导出 2 条请求：/data/tokenledger_gateway_requests.csv'));
    const query = vi.mocked(api.exportRequestLog).mock.calls[0][0];
    expect(query).not.toHaveProperty('offset');
    expect(query).not.toHaveProperty('limit');
  });

  it('展开请求信息后可用该会话的工具键打开详情', async () => {
    render(<RequestLogPage />);
    const table = await screen.findByRole('table', { name: '网关请求日志' });
    const rows = within(table).getAllByRole('row');
    fireEvent.click(within(rows[1]).getByRole('button', { name: /展开/ }));
    const button = screen.getByRole('button', { name: '打开会话 s1 的详情' });
    fireEvent.click(button);
    expect(window.location.hash).toBe('#session/codex/s1');
    expect(screen.getByText('打开后查看本机完整会话，范围可能超出当前报告或请求。')).toBeInTheDocument();
  });

  it('只有采样 ID 命中当前逻辑请求时才显示内容分区，且展开后仍不自动读取', async () => {
    vi.mocked(contentSamplingApi.status).mockResolvedValue({
      mode: 'next', remaining: 18, expiresAt: null, agent: null, group: null, failuresOnly: false,
      sampleIds: ['L1'], storedCount: 1, storedBytes: 2048, error: null,
    });
    render(<RequestLogPage />);
    const table = await screen.findByRole('table', { name: '网关请求日志' });
    const rows = within(table).getAllByRole('row');
    fireEvent.click(within(rows[1]).getByRole('button', { name: /展开/ }));
    expect(await screen.findByRole('region', { name: '采样内容' })).toBeInTheDocument();
    expect(contentSamplingApi.read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '读取样本' }));
    await waitFor(() => expect(contentSamplingApi.read).toHaveBeenCalledWith('L1'));
    fireEvent.click(screen.getByRole('button', { name: /收起/ }));
    expect(screen.queryByRole('region', { name: '采样内容' })).not.toBeInTheDocument();

    fireEvent.click(within(table).getAllByRole('row')[2].querySelector('button')!);
    expect(screen.queryByRole('region', { name: '采样内容' })).not.toBeInTheDocument();
  });
});
