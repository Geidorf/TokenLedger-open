import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AnomalyReport } from '../utils/usageAnomaly';
import { UsageAnomalyView } from './UsageAnomalyPanel';

const today = new Date(2026, 9, 24, 15, 30);

const report = (findings: AnomalyReport['findings'], checks: AnomalyReport['checks'] = []): AnomalyReport => ({
  generatedAt: '2026-10-24T07:30:00Z',
  baselineDays: 14,
  recentDays: 7,
  recentHours: 24,
  findings,
  checks,
});

const spike = {
  id: 'tokenSpike:2026-10-24 15:00:',
  kind: 'tokenSpike' as const,
  granularity: 'hour' as const,
  bucket: '2026-10-24 15:00',
  subject: null,
  tool: null,
  value: 2_400_000,
  baseline: 300_000,
  ratio: 8,
  unit: 'tokens' as const,
  inProgress: false,
  sample: null,
};

function renderView(props: Partial<Parameters<typeof UsageAnomalyView>[0]> = {}) {
  const onNotifyChange = vi.fn();
  const onSelectDate = vi.fn();
  render(
    <UsageAnomalyView
      report={report([])}
      error=""
      notify={false}
      notifySaving={false}
      notifyError=""
      onNotifyChange={onNotifyChange}
      onSelectDate={onSelectDate}
      today={today}
      {...props}
    />,
  );
  return { onNotifyChange, onSelectDate };
}

describe('UsageAnomalyView', () => {
  it('says nothing unusual happened, with the comparison window', () => {
    renderView();
    expect(screen.getByRole('status')).toHaveTextContent('最近 24 小时与 7 天没有发现异常（与此前 14 天比较）');
  });

  it('shows a finding and drills into its day', () => {
    const { onSelectDate } = renderView({ report: report([spike]) });
    const card = screen.getByRole('button', { name: /Token 突增，今天 15:00/ });
    fireEvent.click(card);
    expect(onSelectDate).toHaveBeenCalledWith('2026-10-24', undefined);
  });

  it('passes the model filter when a model surge is opened', () => {
    const { onSelectDate } = renderView({
      report: report([{ ...spike, id: 'm', kind: 'modelSurge', granularity: 'day', bucket: '2026-10-23', subject: 'model-b' }]),
    });
    fireEvent.click(screen.getByRole('button', { name: /model-b 放量/ }));
    expect(onSelectDate).toHaveBeenCalledWith('2026-10-23', { tools: [], models: ['model-b'] });
  });

  it('lists checks that could not run', () => {
    renderView({ report: report([], [{ kind: 'gatewayErrors', state: 'unavailable' }, { kind: 'cacheHitDrop', state: 'insufficientBaseline' }]) });
    expect(screen.getByText('网关错误率突增：本机没有这类数据；缓存命中率骤降：历史不足，暂不评估')).toBeInTheDocument();
  });

  it('toggles notifications through a labelled switch, off by default', () => {
    const { onNotifyChange } = renderView();
    const toggle = screen.getByRole('switch', { name: '异常时系统通知' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(onNotifyChange).toHaveBeenCalledWith(true);
  });

  it('collapses long lists behind a more button', () => {
    const many = Array.from({ length: 8 }, (_, index) => ({ ...spike, id: `s${index}`, bucket: `2026-10-24 0${index}:00` }));
    renderView({ report: report(many) });
    expect(screen.getAllByRole('button', { name: /Token 突增/ })).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: '再显示 2 项' }));
    expect(screen.getAllByRole('button', { name: /Token 突增/ })).toHaveLength(8);
  });
});
