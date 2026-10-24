import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeatmapSection } from './HeatmapSection';

// 固定“现在”为上海时间 2026-09-24 20:00；快照时区显式给出，结果不随宿主时区变化。
const NOW = new Date('2026-09-24T12:00:00Z');
const cutoff = (cutoffDate: string) => ({ cutoffDate, timeZone: 'Asia/Shanghai' });

function dayCell(date: string): HTMLElement {
  return screen.getByLabelText(new RegExp(`^${date}:`));
}

describe('HeatmapSection', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('自定义范围落在往年时画那一年，并如实标注只查询了所选区间（T10.161）', () => {
    const { container } = render(
      <HeatmapSection
        heatmap={{ '2025-11-02': 5_000 }}
        range="custom"
        customRange={{ start: '2025-10-01', end: '2025-12-31' }}
        timeContext={cutoff('2025-12-31')}
        onSelectDate={vi.fn()}
      />,
    );

    expect(screen.getByText('2025 年 Token 消耗日历')).toBeInTheDocument();
    expect(container.querySelector('.heatmap-coverage')).toHaveTextContent(
      '只查询了 2025-10-01 至 2025-12-31，其余日期未查询，不代表没有用量。',
    );
    expect(screen.getByText('未查询')).toBeInTheDocument();
    expect(container.querySelector('.heat-legend .heat-unknown')).not.toBeNull();
    expect(dayCell('2025-03-01')).toHaveAttribute('aria-label', '2025-03-01: 未查询');
    expect(dayCell('2025-10-05')).toHaveAttribute('aria-label', '2025-10-05: 0 Tokens');
  });

  it('今年范围且快照截止到今天：保留“本年度”标题，不出现未查询说明与图例', () => {
    const { container } = render(
      <HeatmapSection heatmap={{}} range="year" customRange={null} timeContext={cutoff('2026-09-24')} />,
    );

    expect(screen.getByText('本年度 Token 消耗日历')).toBeInTheDocument();
    expect(container.querySelector('.heatmap-coverage')).toBeNull();
    expect(container.querySelector('.heat-legend .heat-unknown')).toBeNull();
    const legendLevels = [...container.querySelectorAll('.heat-legend [data-level]')].map((node) => node.getAttribute('data-level'));
    expect(legendLevels).toEqual(['1', '2', '3', '4', '5']);
    expect(dayCell('2026-09-24')).toHaveAttribute('aria-label', '2026-09-24: 0 Tokens');
  });

  it('刷新失败沿用旧快照时，快照截止日之后的日期是未查询而不是 0（P2-1，GLB-01）', () => {
    const { container } = render(
      <HeatmapSection
        heatmap={{ '2026-07-15': 3_000 }}
        range="year"
        customRange={null}
        timeContext={cutoff('2026-07-15')}
      />,
    );

    expect(container.querySelector('.heatmap-coverage')).toHaveTextContent(
      '只查询了 2026-01-01 至 2026-07-15，其余日期未查询，不代表没有用量。',
    );
    expect(container.querySelector('.heat-legend .heat-unknown')).not.toBeNull();
    expect(dayCell('2026-07-15')).toHaveAttribute('aria-label', '2026-07-15: 3.0K Tokens');
    for (const date of ['2026-07-16', '2026-08-01', '2026-09-24']) {
      expect(dayCell(date)).toHaveAttribute('aria-label', `${date}: 未查询`);
    }
    const zeroLabelsAfterCutoff = [...container.querySelectorAll('.heatmap-cell[aria-label$=": 0 Tokens"]')]
      .map((node) => node.getAttribute('aria-label') ?? '')
      .filter((label) => label.slice(0, 10) > '2026-07-15');
    expect(zeroLabelsAfterCutoff).toEqual([]);
  });

  it('无法确认快照截止点时，没有记录的日期一律未查询，并说明原因', () => {
    const { container } = render(
      <HeatmapSection heatmap={{ '2026-03-02': 900 }} range="year" customRange={null} timeContext={null} />,
    );

    expect(container.querySelector('.heatmap-coverage')).toHaveTextContent('无法确认这份数据查询到哪一天');
    expect(dayCell('2026-03-02')).toHaveAttribute('aria-label', '2026-03-02: 900 Tokens');
    expect(dayCell('2026-03-03')).toHaveAttribute('aria-label', '2026-03-03: 未查询');
    expect(container.querySelector('.year-heatmap .heat-0')).toBeNull();
  });

  it('自定义终点晚于今天时画今天所在年，不画一整年“尚未到来”（P3-4）', () => {
    render(
      <HeatmapSection
        heatmap={{ '2026-09-10': 2_000 }}
        range="custom"
        customRange={{ start: '2026-09-01', end: '2027-01-31' }}
        timeContext={cutoff('2026-09-24')}
      />,
    );

    expect(screen.getByText('2026 年 Token 消耗日历')).toBeInTheDocument();
    expect(dayCell('2026-09-10')).toHaveAttribute('aria-label', '2026-09-10: 2.0K Tokens');
    expect(dayCell('2026-09-11')).toHaveAttribute('aria-label', '2026-09-11: 0 Tokens');
    expect(dayCell('2026-10-01')).toHaveAttribute('aria-label', '2026-10-01: 尚未到来');
  });

  it('下钻接线不变：有用量的日期点击后把日期交给 onSelectDate', () => {
    const onSelectDate = vi.fn();
    render(
      <HeatmapSection
        heatmap={{ '2026-09-20': 5_000 }}
        range="year"
        customRange={null}
        timeContext={cutoff('2026-09-24')}
        onSelectDate={onSelectDate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /2026-09-20/ }));
    expect(onSelectDate).toHaveBeenCalledWith('2026-09-20');
  });

  it('云端作用域不传 onSelectDate 时全部日期为静态格，不暴露按钮', () => {
    const { container } = render(
      <HeatmapSection
        heatmap={{ '2026-09-20': 5_000 }}
        range="all"
        customRange={null}
        timeContext={cutoff('2026-09-24')}
        onSelectDate={undefined}
      />,
    );

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(dayCell('2026-09-20')).toHaveAttribute('data-level', '5');
    expect(container.querySelector('.year-heatmap')).toHaveAttribute('tabindex', '0');
  });

  it('跟随拆分指标画记录数，退回 Token 时说明原因', () => {
    const { container, rerender } = render(
      <HeatmapSection heatmap={{ '2026-09-20': 12 }} range="year" customRange={null} timeContext={cutoff('2026-09-24')} metric="requests" />,
    );
    expect(screen.getByText('本年度记录数日历')).toBeInTheDocument();
    expect(dayCell('2026-09-20')).toHaveAttribute('aria-label', '2026-09-20: 12 条记录');
    expect(container.querySelector('.heatmap-coverage')).toBeNull();

    rerender(
      <HeatmapSection heatmap={{ '2026-09-20': 5_000 }} range="year" customRange={null} timeContext={cutoff('2026-09-24')} metricFallback />,
    );
    expect(screen.getByText('本年度 Token 消耗日历')).toBeInTheDocument();
    expect(container.querySelector('.heatmap-coverage')).toHaveTextContent('当前来源没有逐日的记录数与费用，这里显示有效 Token。');

    rerender(
      <HeatmapSection heatmap={{ '2026-09-20': 5_000 }} range="year" customRange={null} timeContext={cutoff('2026-09-24')} drillUnavailableNote="明细暂不能按账号筛选，选中账号时日期不可点开。" />,
    );
    expect(container.querySelector('.heatmap-coverage')).toHaveTextContent('明细暂不能按账号筛选');
  });
});
