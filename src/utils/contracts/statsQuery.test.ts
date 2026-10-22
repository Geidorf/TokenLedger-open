import { describe, expect, it } from 'vitest';
import dailyCostsFixture from '../../../fixtures/dashboard-stats-v2/daily-costs-v2.json';
import unavailableCostsFixture from '../../../fixtures/dashboard-stats-v2/daily-costs-unavailable-v2.json';
import legacyFixture from '../../../fixtures/dashboard-stats-v2/legacy-v1.json';
import missingOptionalsFixture from '../../../fixtures/dashboard-stats-v2/missing-optionals-v2.json';
import completeFixture from '../../../fixtures/dashboard-stats-v2/complete-v2.json';
import {
  customRangeSpanDays,
  isoCalendarDayValue,
  MAX_CUSTOM_RANGE_DAYS,
  normalizeStatsQuery,
  parseStatsDataContract,
  QueryContractError,
  queryEchoMatches,
  statsQueryKey,
} from './statsQuery';

const base = { timezone: 'Asia/Shanghai', machines: [], tools: [], models: [], search: null, tokenMode: 'effective' };

describe('normalizeStatsQuery 自定义日期区间（T10.108）', () => {
  it('custom 范围把闭区间两端写进 canonical 上下文与查询键', () => {
    const query = normalizeStatsQuery({ ...base, range: 'custom', start: ' 2026-08-01 ', end: '2026-08-31' });
    expect(query).toMatchObject({ range: 'custom', start: '2026-08-01', end: '2026-08-31' });
    const shifted = normalizeStatsQuery({ ...base, range: 'custom', start: '2026-08-02', end: '2026-08-31' });
    expect(statsQueryKey(query)).not.toBe(statsQueryKey(shifted));
    expect(queryEchoMatches({ ...query }, query)).toBe(true);
    expect(queryEchoMatches({ ...query, end: '2026-08-30' }, query)).toBe(false);
  });

  it('预设范围忽略多余的 start/end，避免同一预设出现两个缓存键', () => {
    const plain = normalizeStatsQuery({ ...base, range: 'month' });
    const withBounds = normalizeStatsQuery({ ...base, range: 'month', start: '2026-08-01', end: '2026-08-31' });
    expect(withBounds).toEqual(plain);
    expect('start' in withBounds).toBe(false);
  });

  it('缺日期、格式错误、倒置或超过上限时失败关闭', () => {
    const outcome = (input: Record<string, unknown>) => {
      try {
        normalizeStatsQuery({ ...base, range: 'custom', ...input });
      } catch (error) {
        return error instanceof QueryContractError ? error.code : 'other';
      }
      return 'passed';
    };
    expect(outcome({ start: '2026-08-01' })).toBe('invalid-custom-range');
    expect(outcome({ start: '2026/08/01', end: '2026-08-31' })).toBe('invalid-custom-range');
    expect(outcome({ start: '2026-02-30', end: '2026-03-01' })).toBe('invalid-custom-range');
    expect(outcome({ start: '2026-08-31', end: '2026-08-01' })).toBe('invalid-custom-range');
    expect(outcome({ start: '2024-01-01', end: '2026-09-05' })).toBe('invalid-custom-range');
    expect(outcome({ start: '2024-09-05', end: '2026-09-05' })).toBe('passed');
  });

  it('日期工具按公历闭区间计数', () => {
    expect(isoCalendarDayValue('2026-02-29')).toBeNull();
    expect(isoCalendarDayValue('2028-02-29')).not.toBeNull();
    expect(customRangeSpanDays('2026-08-01', '2026-08-31')).toBe(31);
    expect(customRangeSpanDays('2026-08-02', '2026-08-02')).toBe(1);
    expect(customRangeSpanDays('2026-08-03', '2026-08-02')).toBeNull();
    expect(MAX_CUSTOM_RANGE_DAYS).toBe(731);
  });
});


function dailyFixture(name = 'daily-costs-v2.json') {
  const fixtures: Record<string, unknown> = {
    'daily-costs-v2.json': dailyCostsFixture,
    'daily-costs-unavailable-v2.json': unavailableCostsFixture,
    'legacy-v1.json': legacyFixture,
    'missing-optionals-v2.json': missingOptionalsFixture,
    'complete-v2.json': completeFixture,
  };
  return JSON.parse(JSON.stringify(fixtures[name]));
}

describe('dailyCosts 可选日金额契约（T10.118b）', () => {
  it('共享fixture保留完整正有限日金额与未知日原因，不改变旧核心', () => {
    for (const name of ['daily-costs-v2.json', 'daily-costs-unavailable-v2.json']) {
      const source = dailyFixture(name);
      const parsed = parseStatsDataContract(source);
      expect(parsed.dailyCosts).toEqual(source.dailyCosts);
      expect(parsed.summary).toEqual(source.summary);
      expect(parsed.heatmap).toEqual(source.heatmap);
    }
  });

  it.each(['legacy-v1.json', 'missing-optionals-v2.json', 'complete-v2.json'])('%s 缺新字段仍可用，不补数组或金额', (name) => {
    const result = parseStatsDataContract(dailyFixture(name));
    expect(result.dailyCosts).toBeUndefined();
    expect('dailyCosts' in result).toBe(false);
  });

  it.each([{ value: null }, { value: {} }, { value: [] }, { value: 'invalid' }])('扩展错误形状整体丢弃而保留核心 $value', ({ value: dailyCosts }) => {
    const source = dailyFixture();
    source.dailyCosts = dailyCosts;
    expect(parseStatsDataContract(source).dailyCosts).toBeUndefined();
    expect(parseStatsDataContract(source).summary.totalCost).toBe(1.25);
  });

  it.each([0, -1, NaN, Infinity, -Infinity, '0.42', null])('recorded-estimate 拒绝非法或无依据零金额 %s', (amount) => {
    const source = dailyFixture();
    source.dailyCosts.days[0].amountUsd = amount;
    expect(parseStatsDataContract(source).dailyCosts).toBeUndefined();
  });

  it('不可得必须显式null且原因已知；状态组合不能自相矛盾', () => {
    const mutations = [
      (x: ReturnType<typeof dailyFixture>) => { delete x.dailyCosts.days[0].amountUsd; },
      (x: ReturnType<typeof dailyFixture>) => { x.dailyCosts.days[0].amountUsd = 0; },
      (x: ReturnType<typeof dailyFixture>) => { x.dailyCosts.days[0].reason = 'future-reason'; },
      (x: ReturnType<typeof dailyFixture>) => { x.dailyCosts.days[0].status = 'future-status'; },
    ];
    for (const mutate of mutations) {
      const source = dailyFixture('daily-costs-unavailable-v2.json');
      mutate(source);
      expect(parseStatsDataContract(source).dailyCosts).toBeUndefined();
    }
    const complete = dailyFixture();
    complete.dailyCosts.days[0].reason = null;
    expect(parseStatsDataContract(complete).dailyCosts).toBeUndefined();
  });

  it('partial只能保留incomplete-coverage不可得行，不能显示部分金额', () => {
    const source = dailyFixture();
    source.dailyCosts.coverage.state = 'partial';
    expect(parseStatsDataContract(source).dailyCosts).toBeUndefined();
    source.dailyCosts.days = [{ date: '2026-07-14', amountUsd: null, status: 'unavailable', reason: 'incomplete-coverage' }];
    expect(parseStatsDataContract(source).dailyCosts?.coverage.state).toBe('partial');
    source.dailyCosts.days[0].reason = 'missing-cost';
    expect(parseStatsDataContract(source).dailyCosts).toBeUndefined();
  });

  it.each(['2026-06-30', '2026-07-16', '2026-02-30', '2026/07/14'])('日期不能越过覆盖或伪造公历日 %s', (date) => {
    const source = dailyFixture();
    source.dailyCosts.days[0].date = date;
    expect(parseStatsDataContract(source).dailyCosts).toBeUndefined();
  });

  it('重复/倒序日期整体拒绝，不静默排序过滤拼成假完整覆盖', () => {
    const duplicate = dailyFixture();
    duplicate.dailyCosts.days[1].date = duplicate.dailyCosts.days[0].date;
    expect(parseStatsDataContract(duplicate).dailyCosts).toBeUndefined();
    const reversed = dailyFixture();
    reversed.dailyCosts.days.reverse();
    expect(parseStatsDataContract(reversed).dailyCosts).toBeUndefined();
  });

  it('无元数据、无可信截止、时区冲突或未知时区使扩展不可得', () => {
    const mutations = [
      (x: ReturnType<typeof dailyFixture>) => { delete x.meta; },
      (x: ReturnType<typeof dailyFixture>) => { delete x.meta.generatedAt; },
      (x: ReturnType<typeof dailyFixture>) => { x.meta.generatedAt = '2026-02-30T09:30:00Z'; },
      (x: ReturnType<typeof dailyFixture>) => { x.meta.generatedAt = '2026-07-15T25:30:00Z'; },
      (x: ReturnType<typeof dailyFixture>) => { x.meta.timezone = 'UTC'; },
      (x: ReturnType<typeof dailyFixture>) => { x.dailyCosts.coverage.timezone = 'Unknown/Zone'; },
      (x: ReturnType<typeof dailyFixture>) => { x.comparison = { window: { timezone: 'UTC', currentEnd: x.meta.generatedAt } }; },
    ];
    for (const mutate of mutations) {
      const source = dailyFixture();
      mutate(source);
      expect(parseStatsDataContract(source).dailyCosts).toBeUndefined();
      expect(parseStatsDataContract(source).summary.totalTokens).toBe(900);
    }
  });

  it.each([
    { timezone: 'UTC', currentEnd: '2026-07-16T00:00:00Z' },
    { timezone: 'Asia/Shanghai', currentEnd: 'not-a-time' },
    { timezone: 'Asia/Shanghai', currentEnd: 123 },
    { timezone: null },
  ])('comparison缺periods也校验原始window元数据 %j', (window) => {
    const source = dailyFixture();
    source.comparison = { window };
    const parsed = parseStatsDataContract(source);
    expect(parsed.dailyCosts).toBeUndefined();
    expect(parsed.summary.totalTokens).toBe(900);
  });

  it.each([undefined, {}, { window: {} }, { window: { currentEnd: null } }])(
    'comparison或window可选元数据缺失时仍使用generatedAt %j', (comparison) => {
      const source = dailyFixture();
      source.comparison = comparison;
      expect(parseStatsDataContract(source).dailyCosts).toEqual(source.dailyCosts);
    },
  );

  it('comparison缺periods时有效window截止仍优先于generatedAt', () => {
    const source = dailyFixture();
    source.comparison = { window: { timezone: 'Asia/Shanghai', currentEnd: '2026-07-14T23:00:00+08:00' } };
    source.dailyCosts.coverage.end = '2026-07-14';
    source.dailyCosts.days.pop();
    expect(parseStatsDataContract(source).dailyCosts).toEqual(source.dailyCosts);
  });

  it.each([
    ['today', '2026-07-15'], ['week', '2026-07-13'], ['month', '2026-07-01'],
    ['year', '2026-01-01'], ['all', null],
  ])('%s 覆盖必须匹配canonical自然范围', (range, start) => {
    const source = dailyFixture();
    source.meta.query.range = range;
    source.dailyCosts.coverage.start = start;
    source.dailyCosts.days = [{ date: '2026-07-15', amountUsd: 0.83, status: 'recorded-estimate' }];
    expect(parseStatsDataContract(source).dailyCosts?.coverage.start).toBe(start);
    source.dailyCosts.coverage.start = start === null ? '2026-01-01' : null;
    expect(parseStatsDataContract(source).dailyCosts).toBeUndefined();
  });

  it('custom跨年和未来end截断，历史end不能偷偷扩到现在', () => {
    const source = dailyFixture();
    source.meta.query = { ...source.meta.query, range: 'custom', start: '2025-12-31', end: '2026-08-01' };
    source.dailyCosts.coverage.start = '2025-12-31';
    expect(parseStatsDataContract(source).dailyCosts?.coverage.end).toBe('2026-07-15');
    source.meta.query.end = '2026-07-14';
    source.dailyCosts.days.pop();
    expect(parseStatsDataContract(source).dailyCosts).toBeUndefined();
    source.dailyCosts.coverage.end = '2026-07-14';
    expect(parseStatsDataContract(source).dailyCosts?.days).toHaveLength(1);
  });

  it('冗余meta.range缺失与preset日期字段不改变canonical日覆盖', () => {
    const source = dailyFixture();
    delete source.meta.range;
    source.meta.query.start = '2020-01-01';
    source.meta.query.end = '2030-01-01';
    expect(parseStatsDataContract(source).dailyCosts?.days).toHaveLength(2);
  });

  it('future-only custom即使空数组也不伪称可信覆盖', () => {
    const source = dailyFixture();
    source.meta.query = { ...source.meta.query, range: 'custom', start: '2026-07-16', end: '2026-07-20' };
    source.dailyCosts.coverage.start = '2026-07-16';
    source.dailyCosts.days = [];
    expect(parseStatsDataContract(source).dailyCosts).toBeUndefined();
  });

  it('只有日期的截止值不是可信请求时间戳', () => {
    const source = dailyFixture();
    source.meta.generatedAt = '2026-07-15';
    expect(parseStatsDataContract(source).dailyCosts).toBeUndefined();
  });

  it('DST按声明时区转换UTC截止点，comparison截止优先于生成时间', () => {
    const source = dailyFixture();
    source.meta.timezone = source.meta.query.timezone = source.dailyCosts.coverage.timezone = 'America/New_York';
    source.meta.query.range = 'week';
    source.meta.generatedAt = '2026-03-09T08:00:00Z';
    source.comparison = { window: { timezone: 'America/New_York', currentEnd: '2026-03-09T03:30:00Z' } };
    source.dailyCosts.coverage.start = '2026-03-02';
    source.dailyCosts.coverage.end = '2026-03-08';
    source.dailyCosts.days = [{ date: '2026-03-08', amountUsd: 0.01, status: 'recorded-estimate' }];
    expect(parseStatsDataContract(source).dailyCosts?.coverage.end).toBe('2026-03-08');
  });

  it('接受可信当地时间、空集和未知附加key，不修改源对象', () => {
    const source = dailyFixture();
    source.meta.generatedAt = '2026-07-15 09:30:00.123';
    source.dailyCosts.days = [];
    source.dailyCosts.futureField = { anything: true };
    expect(parseStatsDataContract(source).dailyCosts?.days).toEqual([]);
    expect(source.dailyCosts.futureField).toEqual({ anything: true });
  });
});

describe('parseStatsDataContract 的 tools/models 逐条目 input/output 校验（T10.169 复核 P2，T10.180 补齐）', () => {
  it('input、output 均为有限非负数时通过', () => {
    const parsed = parseStatsDataContract(dailyFixture('complete-v2.json'));
    expect(parsed.tools.codex.input).toBe(900);
    expect(parsed.models['gpt-5'].output).toBe(300);
  });

  it('tools 与 models 条目缺少 input/output 时视为可选字段，不报错', () => {
    const source = dailyFixture('complete-v2.json');
    delete source.tools.codex.input;
    delete source.tools.codex.output;
    delete source.models['gpt-5'].input;
    delete source.models['gpt-5'].output;
    expect(() => parseStatsDataContract(source)).not.toThrow();
  });

  it.each([-1, NaN, Infinity, -Infinity, '900', null, true, {}])(
    'tools.codex.input 为非法值 %s 时整条响应判为 malformed',
    (badValue) => {
      const source = dailyFixture('complete-v2.json');
      source.tools.codex.input = badValue;
      expect(() => parseStatsDataContract(source)).toThrow(/tools\.codex\.input 无效/);
    },
  );

  it.each([-1, NaN, Infinity, -Infinity, '300', null])(
    'models["gpt-5"].output 为非法值 %s 时整条响应判为 malformed',
    (badValue) => {
      const source = dailyFixture('complete-v2.json');
      source.models['gpt-5'].output = badValue;
      expect(() => parseStatsDataContract(source)).toThrow(/models\.gpt-5\.output 无效/);
    },
  );

  it('tools 条目本身不是对象时判为 malformed', () => {
    const source = dailyFixture('complete-v2.json');
    source.tools.codex = 12345;
    expect(() => parseStatsDataContract(source)).toThrow(/tools\.codex 不是对象/);
  });

  it('models 条目本身不是对象时判为 malformed', () => {
    const source = dailyFixture('complete-v2.json');
    source.models['gpt-5'] = null;
    expect(() => parseStatsDataContract(source)).toThrow(/models\.gpt-5 不是对象/);
  });
});
