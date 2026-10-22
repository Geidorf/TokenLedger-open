import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuotaProviderEnvelope, QuotaWindowSnapshot } from '../types';
import { QuotaHighlights } from './QuotaHighlights';

const now = Date.parse('2026-10-06T08:00:00Z');
function windowFixture(id: string, used = 25): QuotaWindowSnapshot {
  return { providerId: 'openai-codex-local', windowId: id, windowLabel: id, scope: 'consumer-subscription',
    source: 'local-authorized', status: 'ok', used, limit: 100, remaining: 100 - used, unit: 'percent',
    observedAt: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString(),
    resetsAt: new Date(now + 3600_000).toISOString(), staleAfterSeconds: 900 };
}
function provider(windows = [windowFixture('primary')]): QuotaProviderEnvelope {
  return { schemaVersion: 1, providerId: 'openai-codex-local', displayName: 'OpenAI Codex',
    scope: 'consumer-subscription', mode: 'automatic', capability: 'stable', status: 'ok', windows };
}
function show(providers: QuotaProviderEnvelope[], refreshFailed = false) {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const onOpen = vi.fn();
  render(<QuotaHighlights providers={providers} refreshFailed={refreshFailed} onOpen={onOpen} />);
  return onOpen;
}
afterEach(() => vi.useRealTimers());

describe('首屏额度摘要', () => {
  it('只显示最紧的三个百分比窗口，详情按钮可操作', () => {
    const onOpen = show([provider([windowFixture('a', 10), windowFixture('b', 90), windowFixture('c', 70), windowFixture('d', 50)])]);
    expect(screen.getAllByText(/%$/).map(node => node.textContent)).toEqual(['10%', '30%', '50%']);
    fireEvent.click(screen.getByRole('button', { name: /查看全部额度（4 个窗口）/ }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
  it('不把绝对余额、非法数据、需授权和公司key窗口转为百分比', () => {
    const w = windowFixture('primary');
    const companyId = 'company-openapi-test';
    show([{ ...provider(), status: 'auth-required' }, provider([{ ...w, remaining: 999 }]),
      provider([{ ...w, unit: 'credits', used: undefined, limit: undefined, remaining: 42 }]),
      { ...provider(), providerId: companyId, scope: 'api-organization', windows: [
        { ...w, providerId: companyId, scope: 'api-organization', windowId: 'key-daily' },
      ] }]);
    expect(screen.queryByRole('region', { name: '首屏额度摘要' })).not.toBeInTheDocument();
  });
  it('来源陈旧或刷新失败都标历史值，不展示尚未发生的重置承诺', () => {
    show([{ ...provider([{ ...windowFixture('primary'), status: 'stale' }]), status: 'stale' }], true);
    expect(screen.getByText('历史可用')).toBeInTheDocument();
    expect(screen.getByText('更新失败 · 请刷新后确认')).toBeInTheDocument();
    expect(screen.queryByText(/分钟后重置/)).not.toBeInTheDocument();
  });
  it('停留页面超过有效期会把读数降为历史数据', () => {
    show([provider()]);
    expect(screen.getByText('可用')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(900_000));
    expect(screen.getByText('历史可用')).toBeInTheDocument();
  });
  it('相同provider与窗口在不同scope分别保留', () => {
    const p = provider();
    show([p, { ...p, scope: 'api-organization', windows: p.windows.map(w => ({...w, scope: 'api-organization'})) }]);
    expect(within(screen.getByRole('region', {name:'首屏额度摘要'})).getAllByText('75%')).toHaveLength(2);
  });
});
