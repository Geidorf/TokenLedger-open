import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DecisionTrace } from './DecisionTrace';
import { traceHeadline } from './helpers';
import type { RouteDecision } from './types';

const base: RouteDecision = {
  ts: '2026-10-23T14:00:00Z',
  requestId: 'r1',
  group: 'coding',
  reason: 'failover',
  detail: '按顺序',
  chosen: 'deepseek/deepseek-chat',
  attempts: [
    { member: 'openai/gpt-5', outcome: 'failed', status: 429, error: '上游返回 429：slow down' },
    { member: 'deepseek/deepseek-chat', outcome: 'ok', status: 200 },
  ],
};

describe('DecisionTrace', () => {
  it('逐个成员写出结论与原因，未参与的成员也列出', () => {
    render(<DecisionTrace decision={{
      ...base,
      trace: [
        { member: 'openai/gpt-5', rank: 0, verdict: 'failed', reasons: ['strategy_first', 'rate_limited'], detail: '上游返回 429：slow down' },
        { member: 'deepseek/deepseek-chat', rank: 1, verdict: 'chosen', reasons: ['fallback', 'answered'] },
        { member: 'kimi/k2', rank: null, verdict: 'excluded', reasons: ['cooling_down', 'brand_new_code'] },
      ],
    }} />);
    const items = within(screen.getByRole('list', { name: 'group/coding 成员决策' })).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('失败已切换');
    expect(items[0]).toHaveTextContent('策略首选 · 限流');
    expect(items[0]).toHaveTextContent('slow down');
    expect(items[1]).toHaveTextContent('选中');
    expect(items[1]).toHaveTextContent('备选 · 已响应');
    expect(items[2]).toHaveTextContent('未参与');
    // Unknown codes from a newer gateway are shown as is.
    expect(items[2]).toHaveTextContent('冷却中 · brand_new_code');
  });

  it('旧记录没有 trace 时退回到尝试列表', () => {
    render(<DecisionTrace decision={base} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('失败已切换');
    expect(items[1]).toHaveTextContent('选中');
  });

  it('一句话原因优先说问题，其次说为什么排在这里', () => {
    expect(traceHeadline(['strategy_first', 'quota_exhausted'])).toBe('额度用尽');
    expect(traceHeadline(['rule_match', 'answered'])).toBe('命中规则');
    expect(traceHeadline([])).toBeNull();
  });
});
