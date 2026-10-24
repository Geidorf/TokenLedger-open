import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as api from './api';
import { formatMs, formatRate, HealthBadge, HealthDetail, HealthSpark, healthSummary, ProbeBar } from './ProviderHealth';

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, providerHealth: vi.fn(), setHealthProbe: vi.fn(), probeProviders: vi.fn() };
});
import type { HealthBucket, ProviderHealth } from './types';

const buckets: HealthBucket[] = Array.from({ length: 24 }, (_, hour) => ({
  start: new Date(Date.UTC(2026, 9, 23, 13 + hour)).toISOString(),
  requests: hour === 23 ? 10 : hour === 22 ? 4 : 0,
  failed: hour === 23 ? 3 : 0,
  p95Ms: hour >= 22 ? 4200 : null,
}));

const degraded: ProviderHealth = {
  provider: 'deepseek',
  status: 'degraded',
  reasons: ['cooling_down', 'rate_limited'],
  stats: {
    requests: 14, ok: 11, successRate: 11 / 14, p50Ms: 1830, p95Ms: 7380, rateLimited: 2, skipped: 1,
    codes: [{ code: 'rate_limited', count: 2 }, { code: 'key_missing', count: 1 }, { code: 'upstream_failed', count: 1 }],
    statuses: [{ status: 429, count: 2 }, { status: 401, count: 1 }, { status: 503, count: 1 }],
    lastOkAt: '2026-10-24T12:29:00Z', lastFailureAt: '2026-10-24T12:20:00Z',
  },
  models: [
    { model: 'deepseek-chat', status: 'degraded', stats: { requests: 10, ok: 7, successRate: 0.7, p50Ms: 1800, p95Ms: 7380, rateLimited: 2, skipped: 0, codes: [], statuses: [], lastOkAt: null, lastFailureAt: null } },
    { model: 'deepseek-reasoner', status: 'healthy', stats: { requests: 4, ok: 4, successRate: 1, p50Ms: 5200, p95Ms: 9100, rateLimited: 0, skipped: 0, codes: [], statuses: [], lastOkAt: null, lastFailureAt: null } },
  ],
  buckets,
  recentFailures: [{ ts: '2026-10-24T12:20:00Z', model: 'deepseek-chat', status: 429, code: 'rate_limited', error: '上游返回 429：slow down' }],
  cooling: [{ member: 'deepseek/deepseek-chat', remainingSecs: 42, failures: 2 }],
};

describe('ProviderHealth', () => {
  it('格式化耗时与成功率', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatMs(820)).toBe('820 毫秒');
    expect(formatMs(1830)).toBe('1.8 秒');
    expect(formatMs(25_400)).toBe('25 秒');
    expect(formatRate(null)).toBe('—');
    expect(formatRate(1)).toBe('100%');
    expect(formatRate(11 / 14)).toBe('78.6%');
  });

  it('一句话说明用原因码中文标签', () => {
    expect(healthSummary(degraded)).toBe('近 24 小时 14 次 · 成功 78.6% · P95 7.4 秒 · 冷却中、限流');
    expect(healthSummary({ ...degraded, status: 'idle' })).toBe('近 24 小时没有经网关的请求');
    expect(healthSummary({ ...degraded, status: 'down', reasons: ['key_missing'], stats: { ...degraded.stats, requests: 0 } })).toBe('未设置 Key');
  });

  it('徽标与紧凑圆点带状态和说明', () => {
    const { rerender } = render(<HealthBadge health={degraded} />);
    expect(screen.getByText('降级')).toHaveAttribute('title', healthSummary(degraded));
    rerender(<HealthBadge health={degraded} compact />);
    expect(screen.getByRole('img', { name: '健康度：降级' })).toHaveClass('is-degraded');
    rerender(<HealthBadge health={undefined} />);
    expect(screen.queryByText('降级')).toBeNull();
  });

  it('趋势条每小时一根，失败部分单独着色', () => {
    const { container } = render(<HealthSpark buckets={buckets} label="DeepSeek" />);
    expect(screen.getByRole('img', { name: 'DeepSeek近 24 小时 14 次请求，3 次失败' })).toBeInTheDocument();
    expect(container.querySelectorAll('rect.is-ok')).toHaveLength(2);
    expect(container.querySelectorAll('rect.is-empty')).toHaveLength(22);
    expect(container.querySelectorAll('rect.is-failed')).toHaveLength(1);
  });

  it('详情列出统计、错误分布、冷却、各模型与最近失败', () => {
    render(<HealthDetail health={degraded} name="DeepSeek" />);
    const section = screen.getByRole('region', { name: 'DeepSeek 健康度' });
    expect(within(section).getByText('78.6%')).toBeInTheDocument();
    expect(within(section).getAllByText('7.4 秒')).toHaveLength(2);
    expect(within(section).getByText('未设置 Key × 1')).toBeInTheDocument();
    expect(within(section).getByText('HTTP 429 × 2')).toBeInTheDocument();
    expect(within(section).getByText(/冷却中：deepseek\/deepseek-chat（约 42 秒）/)).toBeInTheDocument();
    expect(within(section).getByText('deepseek-reasoner')).toBeInTheDocument();
    expect(within(section).getByText('上游返回 429：slow down')).toBeInTheDocument();
    expect(within(section).getByText(/不额外访问供应商/)).toBeInTheDocument();
  });

  it('详情显示最近一次探活结果', () => {
    render(<HealthDetail health={{ ...degraded, probes: [{ ts: '2026-10-24T12:20:00Z', ok: false, status: 401, latencyMs: 300, code: 'auth_failed', error: '上游返回 401' }] }} name="DeepSeek" />);
    expect(screen.getByText(/最近探活 .* 鉴权失败（HTTP 401）/)).toBeInTheDocument();
    expect(screen.getByText(/另含主动探活结果/)).toBeInTheDocument();
  });

  it('探活开关默认关，打开后保存设置，立即探活回填报告', async () => {
    const report = { generatedAt: 't', windowHours: 24, probe: { enabled: true, intervalMins: 15 }, providers: [] };
    vi.mocked(api.setHealthProbe).mockResolvedValue({ enabled: true, intervalMins: 15 });
    vi.mocked(api.providerHealth).mockResolvedValue(report);
    vi.mocked(api.probeProviders).mockResolvedValue(report);
    const onReport = vi.fn();
    const onNotify = vi.fn();
    render(<ProbeBar settings={undefined} onReport={onReport} onNotify={onNotify} />);
    const toggle = screen.getByRole('switch', { name: '定时主动探活' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('combobox')).toBeDisabled();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(api.setHealthProbe).toHaveBeenCalledWith({ enabled: true, intervalMins: 15 });
    fireEvent.click(screen.getByRole('button', { name: '立即探活' }));
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith('success', '已探活一次'));
    expect(onReport).toHaveBeenLastCalledWith(report);
  });
});
