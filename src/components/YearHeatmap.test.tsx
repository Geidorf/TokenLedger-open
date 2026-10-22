import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { heatmapCoverageNote, resolveHeatmapWindow, YearHeatmap } from './YearHeatmap';

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

/** 日期格的 aria-label 形如 `2026-08-16: 5.0K Tokens`，以“日期:”锚定避免命中容器 summary。 */
function dayCell(date: string): HTMLElement {
  return screen.getByLabelText(new RegExp(`^${date}:`));
}

describe('YearHeatmap', () => {
  it('用 group 保留年度摘要，同时让可点击日期暴露为独立交互节点', () => {
    const date = todayKey();
    const { container } = render(<YearHeatmap heatmap={{ [date]: 5000 }} onSelectDate={vi.fn()} />);

    const heatmap = container.querySelector('.year-heatmap');
    expect(heatmap).toHaveAttribute('role', 'group');
    expect(heatmap).not.toHaveAttribute('role', 'img');
    expect(heatmap).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('button', { name: new RegExp(date) })).toBeInTheDocument();
  });

  it('点击有消耗的日期触发 onSelectDate 下钻', () => {
    const date = todayKey();
    const onSelectDate = vi.fn();
    render(<YearHeatmap heatmap={{ [date]: 5000 }} onSelectDate={onSelectDate} />);

    const cell = screen.getByRole('button', { name: new RegExp(date) });
    expect(cell).toBeInTheDocument();
    fireEvent.click(cell);
    expect(onSelectDate).toHaveBeenCalledTimes(1);
    expect(onSelectDate).toHaveBeenCalledWith(date);
  });

  it('键盘 Enter 与 Space 均可触发 onSelectDate', () => {
    const date = todayKey();
    const onSelectDate = vi.fn();
    render(<YearHeatmap heatmap={{ [date]: 5000 }} onSelectDate={onSelectDate} />);

    const cell = screen.getByRole('button', { name: new RegExp(date) });
    fireEvent.keyDown(cell, { key: 'Enter' });
    fireEvent.keyDown(cell, { key: ' ' });
    expect(onSelectDate).toHaveBeenCalledTimes(2);
    expect(onSelectDate).toHaveBeenNthCalledWith(1, date);
    expect(onSelectDate).toHaveBeenNthCalledWith(2, date);
  });

  it('零消耗日期不可点击且不暴露 button 语义', () => {
    const date = todayKey();
    render(<YearHeatmap heatmap={{ [date]: 0 }} onSelectDate={vi.fn()} />);

    const cell = dayCell(date);
    expect(cell).not.toHaveAttribute('role', 'button');
    expect(cell).not.toHaveAttribute('tabindex', '0');
  });

  it('未提供 onSelectDate 时不绑定点击处理', () => {
    const date = todayKey();
    render(<YearHeatmap heatmap={{ [date]: 5000 }} />);

    const cell = dayCell(date);
    expect(cell).not.toHaveAttribute('role', 'button');
  });

  it('按本年峰值相对分 5 档（与节奏格同一把尺），不再按 K/M/B 数量级换色相（T10.161）', () => {
    const year = new Date().getFullYear() - 1;
    const { container } = render(
      <YearHeatmap
        year={year}
        heatmap={{ [`${year}-03-01`]: 1_000, [`${year}-03-02`]: 4_500, [`${year}-03-03`]: 10_000 }}
      />,
    );

    expect(dayCell(`${year}-03-01`)).toHaveAttribute('data-level', '1');
    expect(dayCell(`${year}-03-02`)).toHaveAttribute('data-level', '3');
    expect(dayCell(`${year}-03-03`)).toHaveAttribute('data-level', '5');
    expect(dayCell(`${year}-03-04`)).toHaveClass('heat-0');
    expect(dayCell(`${year}-03-04`)).not.toHaveAttribute('data-level');
    expect(container.querySelector('[class*="heat-k"], [class*="heat-m"], [class*="heat-b"], .heat-low')).toBeNull();
  });

  it('画往年并区分“未查询”与“已查询的 0”：未查询日期不说成 0，也不可点击（GLB-01）', () => {
    const year = new Date().getFullYear() - 1;
    const onSelectDate = vi.fn();
    const { container } = render(
      <YearHeatmap
        year={year}
        coverage={{ start: `${year}-10-01`, end: `${year}-12-31` }}
        heatmap={{ [`${year}-11-02`]: 5_000 }}
        onSelectDate={onSelectDate}
      />,
    );

    const outside = dayCell(`${year}-03-01`);
    expect(outside).toHaveAttribute('aria-label', `${year}-03-01: 未查询`);
    expect(outside).toHaveClass('heat-unknown');
    expect(outside).not.toHaveClass('heat-0');
    expect(outside).not.toHaveAttribute('role', 'button');

    const knownZero = dayCell(`${year}-10-05`);
    expect(knownZero).toHaveAttribute('aria-label', `${year}-10-05: 0 Tokens`);
    expect(knownZero).toHaveClass('heat-0');

    const active = screen.getByRole('button', { name: new RegExp(`${year}-11-02`) });
    expect(active).toHaveAttribute('data-level', '5');
    fireEvent.click(active);
    expect(onSelectDate).toHaveBeenCalledWith(`${year}-11-02`);

    const summary = container.querySelector('.year-heatmap')?.getAttribute('aria-label') ?? '';
    expect(summary).toContain(`${year} 年活跃日历：1 个有消耗的日期`);
    expect(summary).toContain('其余日期未查询，不代表没有用量');
  });

  it('覆盖之外但响应里确有记录的日期按已知数据显示，不被藏成未查询', () => {
    const year = new Date().getFullYear() - 1;
    render(
      <YearHeatmap
        year={year}
        coverage={{ start: `${year}-10-01`, end: `${year}-12-31` }}
        heatmap={{ [`${year}-02-10`]: 800 }}
      />,
    );

    expect(dayCell(`${year}-02-10`)).toHaveAttribute('aria-label', `${year}-02-10: 800 Tokens`);
    expect(dayCell(`${year}-02-10`)).toHaveAttribute('data-level', '5');
  });

  it('未来日期标为尚未到来，不写 0 Token', () => {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    if (tomorrow.getFullYear() !== now.getFullYear()) return; // 12 月 31 日当天本年没有未来日期
    const key = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
    render(<YearHeatmap heatmap={{ [key]: 9_999 }} onSelectDate={vi.fn()} />);

    expect(dayCell(key)).toHaveAttribute('aria-label', `${key}: 尚未到来`);
    expect(dayCell(key)).toHaveClass('heat-future');
    expect(dayCell(key)).not.toHaveAttribute('role', 'button');
  });
});

describe('YearHeatmap 覆盖终点与今天', () => {
  it('覆盖终点之后、今天之前的日期是未查询，不是 0（陈旧快照，GLB-01）', () => {
    render(
      <YearHeatmap
        year={2026}
        today="2026-09-24"
        coverage={{ start: '2026-01-01', end: '2026-07-15' }}
        heatmap={{ '2026-07-15': 4_000 }}
      />,
    );

    expect(dayCell('2026-07-15')).toHaveAttribute('aria-label', '2026-07-15: 4.0K Tokens');
    expect(dayCell('2026-07-10')).toHaveAttribute('aria-label', '2026-07-10: 0 Tokens');
    for (const date of ['2026-07-16', '2026-08-31', '2026-09-24']) {
      expect(dayCell(date)).toHaveAttribute('aria-label', `${date}: 未查询`);
      expect(dayCell(date)).toHaveClass('heat-unknown');
    }
    expect(dayCell('2026-09-25')).toHaveAttribute('aria-label', '2026-09-25: 尚未到来');
  });

  it('截止点未知时只有响应里有记录的日期算已知，其余一律未查询', () => {
    const { container } = render(
      <YearHeatmap
        year={2026}
        today="2026-09-24"
        coverage={{ start: '2026-01-01', end: null }}
        heatmap={{ '2026-03-02': 900 }}
      />,
    );

    expect(dayCell('2026-03-02')).toHaveAttribute('aria-label', '2026-03-02: 900 Tokens');
    expect(dayCell('2026-03-03')).toHaveAttribute('aria-label', '2026-03-03: 未查询');
    expect(container.querySelector('.heat-0')).toBeNull();
    expect(container.querySelector('.year-heatmap')?.getAttribute('aria-label')).toContain('无法确认这份数据查询到哪一天');
  });
});

describe('resolveHeatmapWindow', () => {
  // 有快照时区的用例按 Asia/Shanghai 取今天，与宿主时区无关。
  const now = new Date('2026-09-24T12:00:00Z');
  // 截止点未知时今天退回本机日期。本机偏移跨 UTC−12 至 UTC+14，同一瞬间可能落在
  // 相邻两天，任何固定 now 都找不到全球同日的时刻，所以期望值也按本机日期算。
  const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const shanghai = (cutoffDate: string) => ({ cutoffDate, timeZone: 'Asia/Shanghai' });

  it('自定义范围画区间终点所在年，覆盖到快照截止点', () => {
    expect(resolveHeatmapWindow('custom', { start: '2025-10-01', end: '2025-12-31' }, shanghai('2025-12-31'), now))
      .toEqual({ year: 2025, today: '2026-09-24', coverage: { start: '2025-10-01', end: '2025-12-31' } });
    expect(resolveHeatmapWindow('custom', { start: '2025-11-15', end: '2026-01-20' }, shanghai('2026-01-20'), now))
      .toEqual({ year: 2026, today: '2026-09-24', coverage: { start: '2025-11-15', end: '2026-01-20' } });
  });

  it('自定义终点晚于今天时画今天所在年，不画一整年“尚未到来”', () => {
    expect(resolveHeatmapWindow('custom', { start: '2026-09-01', end: '2027-01-31' }, shanghai('2026-09-24'), now))
      .toEqual({ year: 2026, today: '2026-09-24', coverage: { start: '2026-09-01', end: '2026-09-24' } });
  });

  it('快照截止早于区间终点时，覆盖只到截止日，年份跟着最后一个已查询的日期', () => {
    expect(resolveHeatmapWindow('custom', { start: '2025-12-01', end: '2026-01-31' }, shanghai('2025-12-31'), now))
      .toEqual({ year: 2025, today: '2026-09-24', coverage: { start: '2025-12-01', end: '2025-12-31' } });
  });

  it('预设范围覆盖到快照截止日而不是本机今天；窗口起点按截止日推算', () => {
    expect(resolveHeatmapWindow('year', null, shanghai('2026-07-15'), now))
      .toEqual({ year: 2026, today: '2026-09-24', coverage: { start: '2026-01-01', end: '2026-07-15' } });
    expect(resolveHeatmapWindow('all', null, shanghai('2026-09-24'), now))
      .toEqual({ year: 2026, today: '2026-09-24', coverage: { start: null, end: '2026-09-24' } });
    expect(resolveHeatmapWindow('month', null, shanghai('2026-09-24'), now))
      .toEqual({ year: 2026, today: '2026-09-24', coverage: { start: '2026-09-01', end: '2026-09-24' } });
    expect(resolveHeatmapWindow('week', null, shanghai('2026-09-24'), now))
      .toEqual({ year: 2026, today: '2026-09-24', coverage: { start: '2026-09-21', end: '2026-09-24' } });
    // 跨年陈旧快照：窗口是去年的“今年”，今年日期全部未查询。
    expect(resolveHeatmapWindow('year', null, shanghai('2025-12-31'), new Date('2026-01-02T09:00:00+08:00')))
      .toEqual({ year: 2026, today: '2026-01-02', coverage: { start: '2025-01-01', end: '2025-12-31' } });
  });

  it('截止点未知时终点为 null，不借用本机时钟声明已查询', () => {
    expect(resolveHeatmapWindow('year', null, null, now).coverage).toEqual({ start: '2026-01-01', end: null });
    expect(resolveHeatmapWindow('all', null, undefined, now).coverage).toEqual({ start: null, end: null });
    expect(resolveHeatmapWindow('custom', { start: '2025-10-01', end: '2025-12-31' }, null, now))
      .toEqual({ year: 2025, today: localToday, coverage: { start: '2025-10-01', end: null } });
    expect(resolveHeatmapWindow('custom', null, shanghai('2026-09-24'), now).coverage).toEqual({ start: null, end: null });
  });

  it('今天按快照时区计算；截止日晚于今天时截到今天', () => {
    const lateUtc = new Date('2026-09-24T20:00:00Z');
    expect(resolveHeatmapWindow('year', null, { cutoffDate: '2026-09-25', timeZone: 'Asia/Shanghai' }, lateUtc).today).toBe('2026-09-25');
    expect(resolveHeatmapWindow('year', null, { cutoffDate: '2026-09-25', timeZone: 'America/Los_Angeles' }, lateUtc))
      .toEqual({ year: 2026, today: '2026-09-24', coverage: { start: '2026-01-01', end: '2026-09-24' } });
  });

  it('不知道范围时不声明覆盖（专属看板年度底图的旧语义）', () => {
    expect(resolveHeatmapWindow(undefined, null, shanghai('2026-09-24'), now))
      .toEqual({ year: 2026, today: '2026-09-24', coverage: null });
  });
});

describe('heatmapCoverageNote', () => {
  const today = '2026-09-24';

  it('本年已到来的日期都查询过时不出说明', () => {
    expect(heatmapCoverageNote(2026, { start: '2026-01-01', end: '2026-09-24' }, today)).toBe('');
    expect(heatmapCoverageNote(2026, { start: null, end: '2026-09-24' }, today)).toBe('');
    expect(heatmapCoverageNote(2026, null, today)).toBe('');
  });

  it('只查询了一段时如实说明其余日期未查询', () => {
    expect(heatmapCoverageNote(2025, { start: '2025-10-01', end: '2025-12-31' }, today))
      .toBe('只查询了 2025-10-01 至 2025-12-31，其余日期未查询，不代表没有用量。');
  });

  it('陈旧快照只查询到截止日时同样说明', () => {
    expect(heatmapCoverageNote(2026, { start: '2026-01-01', end: '2026-07-15' }, today))
      .toBe('只查询了 2026-01-01 至 2026-07-15，其余日期未查询，不代表没有用量。');
  });

  it('区间跨年时说明起点所在年的部分不在本日历中', () => {
    expect(heatmapCoverageNote(2026, { start: '2025-11-15', end: '2026-01-20' }, today))
      .toBe('只查询了 2025-11-15 至 2026-01-20，其余日期未查询，不代表没有用量；2025 年的部分不在本日历中。');
  });

  it('截止点未知时说明无法确认', () => {
    expect(heatmapCoverageNote(2026, { start: '2026-01-01', end: null }, today))
      .toBe('无法确认这份数据查询到哪一天，没有记录的日期都按未查询显示，不代表没有用量。');
  });
});
