import { describe, expect, it } from 'vitest';
import {
  ANOMALY_KINDS,
  RULE_TEXT,
  bucketLabel,
  describeFinding,
  findingDrill,
  parseAnomalyReport,
  parseAnomalySettings,
  type AnomalyFinding,
} from './usageAnomaly';

const today = new Date(2026, 9, 24, 15, 30);

function finding(overrides: Partial<AnomalyFinding>): AnomalyFinding {
  return {
    id: 'tokenSpike:2026-10-24 15:00:',
    kind: 'tokenSpike',
    granularity: 'hour',
    bucket: '2026-10-24 15:00',
    subject: null,
    tool: null,
    value: 2_400_000,
    baseline: 300_000,
    ratio: 8,
    unit: 'tokens',
    inProgress: true,
    sample: null,
    ...overrides,
  };
}

describe('parseAnomalyReport', () => {
  it('keeps well-formed findings and drops malformed ones', () => {
    const report = parseAnomalyReport({
      generatedAt: '2026-10-24T07:30:00Z',
      baselineDays: 14,
      recentDays: 7,
      recentHours: 24,
      findings: [
        finding({}),
        { id: 'x', kind: 'unknownKind', granularity: 'hour', bucket: '', value: 1, baseline: 1, unit: 'tokens' },
        { ...finding({}), value: Number.NaN },
      ],
      checks: [{ kind: 'gatewayErrors', state: 'unavailable' }, { kind: 'nope', state: 'evaluated' }],
    });
    expect(report?.findings).toHaveLength(1);
    expect(report?.checks).toEqual([{ kind: 'gatewayErrors', state: 'unavailable' }]);
  });

  it('rejects a response without lists', () => {
    expect(parseAnomalyReport({ findings: null })).toBeNull();
    expect(parseAnomalyReport('oops')).toBeNull();
  });

  it('defaults notifications to off', () => {
    expect(parseAnomalySettings(null)).toEqual({ notify: false });
    expect(parseAnomalySettings({ notify: 'yes' })).toEqual({ notify: false });
    expect(parseAnomalySettings({ notify: true })).toEqual({ notify: true });
  });
});

describe('describeFinding', () => {
  it('words an hour spike with the usual hour and ratio', () => {
    const copy = describeFinding(finding({}), today);
    expect(copy.title).toBe('Token 突增');
    expect(copy.when).toBe('今天 15:00 · 进行中');
    expect(copy.value).toContain('Tokens');
    expect(copy.comparison).toMatch(/^平时每小时 .+，8×$/);
  });

  it('names the model or Agent for surges and sessions', () => {
    expect(describeFinding(finding({ kind: 'modelSurge', granularity: 'day', bucket: '2026-10-23', subject: 'model-b', inProgress: false }), today))
      .toMatchObject({ title: 'model-b 放量', when: '昨天' });
    const session = describeFinding(finding({
      kind: 'expensiveSession', granularity: 'session', bucket: '2026-10-21', subject: 's1', tool: 'codex', unit: 'usd', value: 12.4, baseline: 1.1, ratio: 11.3, inProgress: false,
    }), today);
    expect(session.title).toBe('Codex 会话异常昂贵');
    expect(session.when).toBe('最近活跃：10-21');
    expect(session.comparison).toContain('常见会话');
  });

  it('words rate findings in percentage points and attempts', () => {
    expect(describeFinding(finding({ kind: 'cacheHitDrop', granularity: 'day', bucket: '2026-10-24', unit: 'rate', value: 0.3, baseline: 0.8, ratio: null }), today).comparison)
      .toBe('平时 80.0%，低 50.0 个百分点');
    expect(describeFinding(finding({ kind: 'gatewayErrors', unit: 'rate', value: 0.4, baseline: 0.05, sample: 30 }), today).comparison)
      .toBe('30 次请求；平时失败率 5.0%');
  });

  it('never shows an unknown cost as zero', () => {
    expect(describeFinding(finding({ kind: 'costSpike', unit: 'usd', value: Number.NaN }), today).value).toBe('不可得');
  });
});

describe('bucketLabel and drill', () => {
  it('labels older days by month-day', () => {
    expect(bucketLabel({ bucket: '2026-10-19', granularity: 'day' }, today)).toBe('10-19');
  });

  it('drills hour and day findings into that day, with the entity for surges', () => {
    expect(findingDrill(finding({}))).toEqual({ date: '2026-10-24', tools: [], models: [] });
    expect(findingDrill(finding({ kind: 'toolSurge', granularity: 'day', bucket: '2026-10-22', subject: 'claude' })))
      .toEqual({ date: '2026-10-22', tools: ['claude'], models: [] });
    expect(findingDrill(finding({ kind: 'gatewayErrors' }))).toBeNull();
    expect(findingDrill(finding({ kind: 'expensiveSession', granularity: 'session' }))).toBeNull();
  });

  it('documents a rule for every kind', () => {
    for (const kind of ANOMALY_KINDS) expect(RULE_TEXT[kind].length).toBeGreaterThan(10);
  });
});
