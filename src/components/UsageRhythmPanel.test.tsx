import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TrendPoint, UsageComparison } from '../types';
import { buildRhythm, type InsightTimeContext, type Rhythm } from '../utils/insightRules';
import { UsageRhythmPanel } from './UsageRhythmPanel';

const SUMMARY = { totalTokens: 55_000, inputTokens: 30_000, outputTokens: 25_000, cachedTokens: 0, totalCost: 0.45, totalRequests: 13, avgTokensPerReq: 4_230 };
const DELTA = { absolute: 0, percent: 0, direction: 'flat' as const };
const HOURLY_COMPARISON: UsageComparison = {
  window: {
    kind: 'dayOverDay',
    timezone: 'Asia/Shanghai',
    bucket: 'hour',
    currentStart: '2026-06-09 00:00:00',
    currentEnd: '2026-06-09 10:30:00',
    previousStart: '2026-06-08 00:00:00',
    previousEnd: '2026-06-08 10:30:00',
    alignedThrough: '2026-06-09 10:30:00',
  },
  current: { summary: SUMMARY, series: [{ bucket: '09:00', tokens: 50_000, requests: 12, cost: 0.4 }, { bucket: '10:00', tokens: 5_000, requests: 1, cost: 0.05 }] },
  previous: { summary: SUMMARY, series: [{ bucket: '09:00', tokens: 25_000, requests: 6, cost: 0.2 }, { bucket: '10:00', tokens: 0, requests: 0, cost: 0 }] },
  delta: { tokens: DELTA, requests: DELTA, cost: DELTA },
};

const todayContext: InsightTimeContext = {
  range: 'today',
  timeZone: 'Asia/Shanghai',
  cutoffDate: '2026-06-09',
  cutoffHour: 10,
  scope: 'local',
};

function requiredRhythm(value: Rhythm | null): Rhythm {
  expect(value).not.toBeNull();
  if (!value) throw new Error('expected rhythm');
  return value;
}

describe('UsageRhythmPanel honesty contract', () => {
  it('renders complete and current hourly buckets while marking future hours unstarted', () => {
    const rhythm = requiredRhythm(buildRhythm([
      { date: '00:00' },
      { date: '09:00', codex: 40_000, claude: 10_000 },
      { date: '10:00', codex: 5_000 },
      { date: '23:00', codex: 9_000_000 },
    ] as TrendPoint[], todayContext));

    render(<UsageRhythmPanel rhythm={rhythm} />);
    expect(screen.getByText('今日分时段节奏')).toBeInTheDocument();
    expect(screen.getByText('仅今日范围有真实小时桶；当前小时标为进行中，未来小时不计入')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('今日活跃峰值 09:00，≈50.0K');
    expect(screen.getByRole('img', { name: '10:00 · 5.0K Tokens（进行中）' })).toHaveClass('is-in-progress');
    expect(screen.getByRole('img', { name: '23:00 · 尚未开始' })).toHaveClass('is-future');
    expect(screen.getByRole('status')).not.toHaveTextContent('9.0M');
  });

  it('renders weekday averages derived only from completed days', () => {
    // 06-01（周一）起 14 个完整日，每个星期几恰好 2 天；06-15 进行中，06-22 未来。
    const trends = Array.from({ length: 14 }, (_, index) => ({
      date: `2026-06-${String(index + 1).padStart(2, '0')}`,
      codex: index % 7 === 0 ? 200_000 : 40_000,
    }));
    const rhythm = requiredRhythm(buildRhythm([
      ...trends,
      { date: '2026-06-15', codex: 8_000_000 },
      { date: '2026-06-22', codex: 9_000_000 },
    ] as TrendPoint[], {
      ...todayContext,
      range: 'month',
      cutoffDate: '2026-06-15',
    }));

    render(<UsageRhythmPanel rhythm={rhythm} />);
    expect(screen.getByText('星期消耗节奏')).toBeInTheDocument();
    expect(screen.getByText('仅以完整日按星期取日均；今天进行中与未来占位日均不计入')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('按 14 个完整日聚合的日均消耗峰值在 周一（≈200.0K');
    expect(screen.getByRole('img', { name: /周二 · 日均 ≈40.0K Tokens/ })).toBeInTheDocument();
  });

  it('星期几观测不足 2 天时只显示原因，不画色阶与图例', () => {
    const rhythm = requiredRhythm(buildRhythm([
      { date: '2026-06-01', codex: 100_000 },
      { date: '2026-06-02', codex: 40_000 },
      { date: '2026-06-08', codex: 300_000 },
      { date: '2026-06-09', codex: 8_000_000 },
    ] as TrendPoint[], {
      ...todayContext,
      range: 'month',
    }));

    render(<UsageRhythmPanel rhythm={rhythm} />);
    expect(screen.getByText('星期消耗节奏')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('已完成 8 天，其中周二、周三、周四、周五、周六、周日不足 2 天，暂不按星期聚合');
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(document.querySelector('.rhythm-strip')).toBeNull();
    expect(document.querySelector('.rhythm-legend')).toBeNull();
  });

  it('悬停或聚焦格子时给出时段、占比、成本、请求、昨日同时段与主要来源；色阶按本期峰值相对着色', () => {
    const rhythm = requiredRhythm(buildRhythm([
      { date: '09:00', codex: 40_000, claude: 10_000 },
      { date: '10:00', codex: 5_000 },
    ] as TrendPoint[], todayContext, HOURLY_COMPARISON));

    render(<UsageRhythmPanel rhythm={rhythm} />);
    const peak = screen.getByRole('img', { name: '09:00 · 50.0K Tokens' });
    const current = screen.getByRole('img', { name: '10:00 · 5.0K Tokens（进行中）' });
    expect(peak).toHaveAttribute('data-level', '5');
    expect(current).toHaveAttribute('data-level', '1');
    expect(screen.getByRole('img', { name: '23:00 · 尚未开始' })).toHaveAttribute('data-level', '0');
    expect(screen.getByRole('img', { name: '23:00 · 尚未开始' })).toHaveAttribute('tabindex', '-1');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('今日活跃峰值 09:00，≈50.0K Tokens（占 91%） · ≈$0.40');

    fireEvent.mouseEnter(peak);
    const tooltip = screen.getByRole('tooltip');
    expect(peak).toHaveAttribute('aria-describedby', tooltip.id);
    expect(tooltip).toHaveTextContent('09:00 – 10:00');
    expect(tooltip).toHaveTextContent('50.0K');
    expect(tooltip).toHaveTextContent(/占今日\s*91%/);
    expect(tooltip).toHaveTextContent(/预估费用\s*≈\$0\.40/);
    expect(tooltip).toHaveTextContent(/请求\s*12 次/);
    expect(tooltip).toHaveTextContent(/昨日同时段\s*25\.0K\s*\+100\.0%/);
    expect(tooltip).toHaveTextContent(/主要来源\s*codex · 80%/);

    fireEvent.mouseLeave(peak.closest('.rhythm-strip-wrap') as HTMLElement);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.focus(current);
    expect(screen.getByRole('tooltip')).toHaveTextContent('进行中');
    expect(screen.getByRole('tooltip')).toHaveTextContent(/昨日同时段\s*0\s*新增/);
    fireEvent.keyDown(current, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('shows an explicit empty note when all started buckets are zero', () => {
    const trends = Array.from({ length: 24 }, (_, hour) => ({
      date: `${String(hour).padStart(2, '0')}:00`,
    })) as TrendPoint[];
    const rhythm = requiredRhythm(buildRhythm(trends, { ...todayContext, cutoffHour: 23 }));

    render(<UsageRhythmPanel rhythm={rhythm} />);
    expect(screen.getByRole('status')).toHaveTextContent('本期暂无消耗，色阶留空');
    expect(screen.getByRole('img', { name: '23:00 · 0 Tokens（进行中）' })).toHaveClass('is-in-progress');
  });
});
