import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { BehaviorAnalysisResponse, StatsData } from '../../types';
import { setLangPreference } from '../../i18n';
import { usePeriodReport, usePeriodReportSettings } from '../../hooks/usePeriodReport';
import { PeriodReportView } from './PeriodReportView';

vi.mock('../../hooks/usePeriodReport', () => ({
  usePeriodReport: vi.fn(),
  usePeriodReportSettings: vi.fn(),
}));

function stats(): StatsData {
  return {
    summary: {
      totalTokens: 300,
      inputTokens: 200,
      outputTokens: 100,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCost: 1,
      totalRequests: 2,
      avgTokensPerReq: 150,
    },
    tools: {},
    models: {},
    trends: [],
    heatmap: {},
    history: [],
  };
}

function behavior(sessions: BehaviorAnalysisResponse['sessions']): BehaviorAnalysisResponse {
  return {
    meta: { sessionsTruncated: false, sessionLimit: 100 },
    sessions,
  } as unknown as BehaviorAnalysisResponse;
}

function mockReport(scope: 'local' | 'cloud', sessions: BehaviorAnalysisResponse['sessions']) {
  vi.mocked(usePeriodReport).mockReturnValue({
    data: { current: stats(), previous: null, behavior: behavior(sessions), budgetRules: [] },
    loading: false,
    error: '',
    reload: vi.fn(),
  });
  vi.mocked(usePeriodReportSettings).mockReturnValue({
    settings: { weekly: false, monthly: false },
    loaded: true,
    saving: false,
    error: '',
    save: vi.fn(),
  });
  return render(
    <PeriodReportView
      scope={scope}
      timezone="Asia/Shanghai"
      quotaProviders={[]}
      onNotify={vi.fn()}
      today="2026-10-21"
    />,
  );
}

describe('PeriodReportView session entries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLangPreference('zh');
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    setLangPreference('zh');
    window.history.replaceState(null, '', '/');
  });

  it('opens a local session with its original tool ID and URL-encodes special characters', () => {
    mockReport('local', [{ id: 'a/b c#1', tool: 'codex', tokens: 300, requests: 2, cost: 1 }]);
    const button = screen.getByRole('button', { name: '打开会话 a/b c#1 的详情' });
    fireEvent.click(button);
    expect(window.location.hash).toBe('#session/codex/a%2Fb%20c%231');
    expect(screen.getByText('打开后查看本机完整会话，范围可能超出当前报告或请求。')).toBeInTheDocument();
  });

  it('does not show entries for cloud reports or placeholder session IDs', () => {
    const cloud = mockReport('cloud', [{ id: 'cloud-session', tool: 'codex', tokens: 300, requests: 2, cost: 1 }]);
    expect(screen.queryByRole('button', { name: /打开会话/ })).toBeNull();
    cloud.unmount();

    mockReport('local', [
      { id: 'unknown_session', tool: 'codex', tokens: 300, requests: 2, cost: 1 },
      { id: '', tool: 'codex', tokens: 200, requests: 1, cost: 0.5 },
      { id: 'real-id', tool: '', tokens: 100, requests: 1, cost: 0.25 },
    ]);
    expect(screen.queryByRole('button', { name: /打开会话/ })).toBeNull();
  });

  it('keeps the same session ID under different tools as separate entries', () => {
    mockReport('local', [
      { id: 'same', tool: 'codex', tokens: 300, requests: 2, cost: 1 },
      { id: 'same', tool: 'claude', tokens: 200, requests: 1, cost: 0.5 },
    ]);
    const buttons = screen.getAllByRole('button', { name: '打开会话 same 的详情' });
    expect(buttons).toHaveLength(2);
    expect(screen.getAllByText('打开后查看本机完整会话，范围可能超出当前报告或请求。')).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(window.location.hash).toBe('#session/codex/same');
    fireEvent.click(buttons[1]);
    expect(window.location.hash).toBe('#session/claude/same');
  });

  it('switches the full-history hint with the interface language', () => {
    mockReport('local', [{ id: 's1', tool: 'codex', tokens: 300, requests: 2, cost: 1 }]);
    expect(screen.getByText('打开后查看本机完整会话，范围可能超出当前报告或请求。')).toBeInTheDocument();
    act(() => setLangPreference('en'));
    expect(screen.getByText('Opens the full local session, which may extend beyond this report or request.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open details of session s1' })).toBeInTheDocument();
  });
});
