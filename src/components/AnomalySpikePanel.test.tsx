import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TrendPoint } from '../types';
import { detectSpikes, type Detection, type InsightTimeContext } from '../utils/insightRules';
import { AnomalySpikePanel } from './AnomalySpikePanel';

function daySeries(values: Record<string, number>): TrendPoint[] {
  return Object.entries(values).map(([date, codex]) => ({ date, codex }));
}

const context: InsightTimeContext = {
  range: 'month',
  timeZone: 'Asia/Shanghai',
  cutoffDate: '2026-06-06',
  cutoffHour: 12,
  scope: 'local',
};

function requiredDetection(value: Detection | null): Detection {
  expect(value).not.toBeNull();
  if (!value) throw new Error('expected detection');
  return value;
}

describe('AnomalySpikePanel detection contract', () => {
  it('labels a current-bucket spike as in progress while using completed buckets as baseline', () => {
    const detection = requiredDetection(detectSpikes(daySeries({
      '2026-06-01': 100_000,
      '2026-06-02': 110_000,
      '2026-06-03': 90_000,
      '2026-06-04': 105_000,
      '2026-06-05': 95_000,
      '2026-06-06': 1_000_000,
      '2026-06-07': 9_000_000,
    }), context));

    render(<AnomalySpikePanel detection={detection} />);
    expect(screen.getByText('消耗突增侦测')).toBeInTheDocument();
    expect(screen.getByText('1 个突增时段')).toBeInTheDocument();
    expect(screen.getByText('2026-06-06（进行中）')).toBeInTheDocument();
    expect(screen.getByText('判定规则：以已完成时段建立稳健基线；进行中时段只作为候选，不进入基线')).toBeInTheDocument();
    expect(screen.queryByText('2026-06-07')).not.toBeInTheDocument();
  });

  it('describes calm as a threshold result over completed buckets, not stable consumption', () => {
    const detection = requiredDetection(detectSpikes(daySeries({
      '2026-06-01': 100_000,
      '2026-06-02': 110_000,
      '2026-06-03': 90_000,
      '2026-06-04': 105_000,
      '2026-06-05': 95_000,
    }), context));

    render(<AnomalySpikePanel detection={detection} />);
    expect(screen.getByRole('status')).toHaveTextContent('基于 5 个已完成时段');
    expect(screen.getByRole('status')).toHaveTextContent('未发现高于中位数');
    expect(screen.getByRole('status')).not.toHaveTextContent('消耗速率平稳');
  });

  it('refuses to evaluate when completed buckets have no stable baseline', () => {
    const detection = requiredDetection(detectSpikes(daySeries({
      '2026-06-01': 0,
      '2026-06-02': 0,
      '2026-06-03': 0,
      '2026-06-04': 0,
      '2026-06-05': 0,
      '2026-06-06': 500_000,
    }), context));

    render(<AnomalySpikePanel detection={detection} />);
    expect(screen.getByRole('status')).toHaveTextContent('已完成的 5 个时段中多数为零');
    expect(screen.getByRole('status')).toHaveTextContent('缺少稳定基线，不评估突增');
  });

  it('names an all-zero completed window honestly', () => {
    const detection = requiredDetection(detectSpikes(daySeries({
      '2026-06-01': 0,
      '2026-06-02': 0,
      '2026-06-03': 0,
      '2026-06-04': 0,
      '2026-06-05': 0,
    }), context));

    render(<AnomalySpikePanel detection={detection} />);
    expect(screen.getByRole('status')).toHaveTextContent('本期暂无消耗，未评估突增');
  });

  it('does not offer drill-down for an hourly in-progress spike', () => {
    const hourlyContext: InsightTimeContext = {
      ...context,
      range: 'today',
      cutoffHour: 5,
    };
    const trends = [
      { date: '00:00', codex: 10 },
      { date: '01:00', codex: 12 },
      { date: '02:00', codex: 9 },
      { date: '03:00', codex: 11 },
      { date: '04:00', codex: 10 },
      { date: '05:00', codex: 900_000 },
      { date: '06:00', codex: 9_000_000 },
    ] as TrendPoint[];
    const detection = requiredDetection(detectSpikes(trends, hourlyContext));

    render(<AnomalySpikePanel detection={detection} onSelectDate={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /查看当日明细/ })).not.toBeInTheDocument();
    expect(screen.getByText('05:00（进行中）')).toBeInTheDocument();
    expect(screen.queryByText('06:00')).not.toBeInTheDocument();
  });

  it('wires real drill-down for a completed day spike', () => {
    const onSelectDate = vi.fn();
    const detection = requiredDetection(detectSpikes(daySeries({
      '2026-06-01': 100_000,
      '2026-06-02': 110_000,
      '2026-06-03': 90_000,
      '2026-06-04': 105_000,
      '2026-06-05': 1_000_000,
    }), context));

    render(<AnomalySpikePanel detection={detection} onSelectDate={onSelectDate} />);
    fireEvent.click(screen.getByRole('button', { name: /查看当日明细/ }));
    expect(onSelectDate).toHaveBeenCalledWith('2026-06-05');
  });

  it('disables the day drill with a visible reason when the prop is set', () => {
    const onSelectDate = vi.fn();
    const detection = requiredDetection(detectSpikes(daySeries({
      '2026-06-01': 100_000,
      '2026-06-02': 110_000,
      '2026-06-03': 90_000,
      '2026-06-04': 105_000,
      '2026-06-05': 1_000_000,
    }), context));
    // T10.185 review P3-4: no real scope produces this any more (`useDayDrill`'s
    // `dayDrillUnavailable` always returns null since T10.113/T10.185). Kept as
    // a synthetic fixture purely to exercise the component's own rendering of
    // a non-null `dateDrillUnavailable` — generic copy on purpose, not a claim
    // about any real scope today.
    const unavailable = { label: '当日明细暂不可用', description: '当前范围或来源暂不支持单日下钻。' };

    render(<AnomalySpikePanel detection={detection} onSelectDate={onSelectDate} dateDrillUnavailable={unavailable} />);
    expect(screen.queryByRole('button', { name: /查看当日明细/ })).not.toBeInTheDocument();
    expect(screen.queryByText('查看当日调用明细')).not.toBeInTheDocument();
    const label = screen.getByText('当日明细暂不可用');
    expect(label.closest('.anomaly-item-card')).toHaveAttribute('title', unavailable.description);
    fireEvent.click(label);
    expect(onSelectDate).not.toHaveBeenCalled();
  });
});
