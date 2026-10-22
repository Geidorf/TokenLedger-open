import { describe, expect, it } from 'vitest';
import validFixture from '../../../fixtures/dashboard-stats-v2/cache-savings-v2.json';
import invalidFixture from '../../../fixtures/dashboard-stats-v2/cache-savings-invalid-v2.json';
import completeFixture from '../../../fixtures/dashboard-stats-v2/complete-v2.json';
import legacyFixture from '../../../fixtures/dashboard-stats-v2/legacy-v1.json';
import missingOptionalsFixture from '../../../fixtures/dashboard-stats-v2/missing-optionals-v2.json';
import { parseCacheSavings, parseStatsDataContract, sanitizeSummaryCacheSavings } from './statsQuery';

// 契约 dashboard-stats-v2 §2.4（T10.183）：summary.cacheSavings 的消费端校验。

interface FixtureCase {
  name: string;
  summary: Record<string, unknown>;
  expected: Record<string, unknown> | null;
}

interface CacheSavingsFixture {
  statsTemplate: Record<string, unknown>;
  cases: FixtureCase[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const valid = clone(validFixture) as unknown as CacheSavingsFixture;
const invalid = clone(invalidFixture) as unknown as CacheSavingsFixture;

function statsWith(summary: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { ...clone(valid.statsTemplate), summary: clone(summary), ...extra };
}

function caseNamed(fixture: CacheSavingsFixture, name: string): FixtureCase {
  const found = fixture.cases.find((item) => item.name === name);
  if (!found) throw new Error(`fixture case ${name} is missing`);
  return found;
}

const listed = caseNamed(valid, 'listed-positive');

describe('summary.cacheSavings 共享 fixture（T10.183）', () => {
  it('合法用例逐个保留，结果等于 expected，未知附加键丢弃，旧核心不变', () => {
    expect(valid.cases.length).toBeGreaterThanOrEqual(9);
    for (const item of valid.cases) {
      const source = statsWith(item.summary);
      const parsed = parseStatsDataContract(source);
      expect(parsed.summary.cacheSavings, item.name).toEqual(item.expected);
      const { cacheSavings: _object, ...core } = parsed.summary;
      const { cacheSavings: _sourceObject, ...sourceCore } = item.summary;
      expect(core, item.name).toEqual(sourceCore);
      expect(parsed.meta?.capabilities?.cacheSavings).toBe(true);
    }
  });

  it('负净值、已知 0 与微小值原样保留（不取整、不当缺失）', () => {
    const parsedNet = (name: string) =>
      parseStatsDataContract(statsWith(caseNamed(valid, name).summary)).summary.cacheSavings?.netSavedUsd;
    expect(parsedNet('negative-net')).toBe(-0.21);
    expect(parsedNet('known-zero-no-discount')).toBe(0);
    expect(parsedNet('known-zero-no-cache')).toBe(0);
    expect(parsedNet('tiny-positive')).toBe(0.00735);
    expect(parsedNet('tiny-negative')).toBe(-0.0075);
  });

  it('非法用例整体丢弃对象，旧核心字段（含 cacheSavedUsd）照常保留', () => {
    expect(invalid.cases.length).toBeGreaterThanOrEqual(20);
    for (const item of invalid.cases) {
      expect(item.expected, item.name).toBeNull();
      const parsed = parseStatsDataContract(statsWith(item.summary));
      expect('cacheSavings' in parsed.summary, item.name).toBe(false);
      const { cacheSavings: _object, ...sourceCore } = item.summary;
      expect(parsed.summary, item.name).toEqual(sourceCore);
    }
  });
});

describe('parseCacheSavings 规则（T10.183）', () => {
  const summary = listed.summary;
  const object = summary.cacheSavings as Record<string, unknown>;
  const withObject = (patch: Record<string, unknown>) => parseCacheSavings({ ...object, ...patch }, summary);

  it('只返回契约的六个字段', () => {
    expect(parseCacheSavings({ ...object, futureBreakdown: { reads: 1 } }, summary)).toEqual(listed.expected);
  });

  it('NaN、Infinity 与负的分量都判为不可得', () => {
    for (const field of ['readSavedUsd', 'writePremiumUsd', 'netSavedUsd']) {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(withObject({ [field]: bad }), `${field}=${bad}`).toBeNull();
      }
    }
    expect(withObject({ readSavedUsd: -0.01, netSavedUsd: -0.76 })).toBeNull();
    expect(withObject({ writePremiumUsd: -0.75, netSavedUsd: 22.35 })).toBeNull();
  });

  it('净值容差是 1e-6 × max(1, 读取节省 + 写入溢价)', () => {
    // 读 + 溢价 = 22.35 → 容差 2.235e-5。
    expect(withObject({ netSavedUsd: 20.85 + 2e-5 })).not.toBeNull();
    expect(withObject({ netSavedUsd: 20.85 + 3e-5 })).toBeNull();
    // 微小值按下限 1e-6：0.0081 − 0 的净值差 2e-6 就不再是同一个数。
    const tiny = { ...summary, cachedTokens: 3000, cacheReadTokens: 3000, cacheWriteTokens: 0, cacheSavedUsd: 0.0081 };
    const tinyObject = { ...object, readSavedUsd: 0.0081, writePremiumUsd: 0, netSavedUsd: 0.0081 };
    expect(parseCacheSavings({ ...tinyObject, netSavedUsd: 0.0081 + 5e-7 }, tiny)).not.toBeNull();
    expect(parseCacheSavings({ ...tinyObject, netSavedUsd: 0.0081 + 2e-6 }, tiny)).toBeNull();
    // 旧毛值字段与读取节省共用同一容差；null 与缺失都视为未给出。
    expect(parseCacheSavings(object, { ...summary, cacheSavedUsd: 21.6 + 2e-5 })).not.toBeNull();
    expect(parseCacheSavings(object, { ...summary, cacheSavedUsd: 21.6 + 3e-5 })).toBeNull();
    expect(parseCacheSavings(object, { ...summary, cacheSavedUsd: null })).not.toBeNull();
    expect(parseCacheSavings(object, { ...summary, cacheSavedUsd: Number.NaN })).toBeNull();
  });

  it('兜底计数必须是不超过对应读写量的非负整数', () => {
    expect(withObject({ fallbackPricedReadTokens: 8_000_000, fallbackPricedWriteTokens: 1_000_000 })).not.toBeNull();
    expect(withObject({ fallbackPricedReadTokens: 8_000_001 })).toBeNull();
    expect(withObject({ fallbackPricedWriteTokens: 1_000_001 })).toBeNull();
    expect(withObject({ fallbackPricedReadTokens: '0' })).toBeNull();
    expect(withObject({ fallbackPricedWriteTokens: Number.NaN })).toBeNull();
  });

  it('读写拆分必须是整数且与合计相符', () => {
    expect(parseCacheSavings(object, { ...summary, cacheReadTokens: 7_999_999.5, cacheWriteTokens: 1_000_000.5 })).toBeNull();
    expect(parseCacheSavings(object, { ...summary, cachedTokens: '9000000' })).toBeNull();
    expect(parseCacheSavings(object, { ...summary, cacheWriteTokens: undefined })).toBeNull();
    expect(parseCacheSavings(object, null)).toBeNull();
  });
});

describe('Stats 响应里每个 summary 都经过校验（T10.183）', () => {
  const invalidObject = caseNamed(invalid, 'net-is-not-read-minus-premium').summary;

  it('同期两段与首屏明细页各自校验，非法的只丢自己那一个', () => {
    const window = { kind: 'monthOverMonth', timezone: 'Asia/Shanghai', bucket: 'day' };
    const source = statsWith(listed.summary, {
      comparison: {
        window,
        current: { summary: clone(listed.summary), series: [] },
        previous: { summary: clone(invalidObject), series: [] },
        delta: {},
      },
      historyPage: {
        items: [],
        hasMore: false,
        totalCount: 1,
        filteredSummary: { ...clone(listed.summary), cacheSavings: { ...listed.expected, futureBreakdown: 1 } },
        availableFilters: { tools: [], models: [], machines: [] },
        granularity: 'request',
      },
    });
    const before = clone(source);
    const parsed = parseStatsDataContract(source);
    expect(parsed.summary.cacheSavings).toEqual(listed.expected);
    expect(parsed.comparison?.current.summary.cacheSavings).toEqual(listed.expected);
    expect(parsed.comparison && 'cacheSavings' in parsed.comparison.previous.summary).toBe(false);
    expect(parsed.comparison?.previous.summary.cacheSavedUsd).toBe(invalidObject.cacheSavedUsd);
    expect(parsed.historyPage?.filteredSummary.cacheSavings).toEqual(listed.expected);
    expect(parsed.comparison?.window).toEqual(window);
    // 解析不改动调用方的原始对象。
    expect(source).toEqual(before);
  });

  it('旧形状与没有该对象的 v2 fixture 解析结果不变', () => {
    const fixtures: Record<string, unknown> = {
      'legacy-v1.json': legacyFixture,
      'complete-v2.json': completeFixture,
      'missing-optionals-v2.json': missingOptionalsFixture,
    };
    for (const [name, fixture] of Object.entries(fixtures)) {
      const source = clone(fixture) as Record<string, unknown>;
      const parsed = parseStatsDataContract(source);
      expect('cacheSavings' in parsed.summary, name).toBe(false);
      expect(parsed.summary, name).toEqual((fixture as { summary: unknown }).summary);
      expect(parsed.comparison ?? null, name).toEqual((fixture as { comparison?: unknown }).comparison ?? null);
    }
  });

  it('sanitizeSummaryCacheSavings 没有对象时原样返回，供明细与专属看板复用', () => {
    const plain = { cachedTokens: 0, totalCost: 0 };
    expect(sanitizeSummaryCacheSavings(plain)).toBe(plain);
    expect(sanitizeSummaryCacheSavings(null)).toBeNull();
    const dropped = sanitizeSummaryCacheSavings({ ...clone(listed.summary), cacheSavings: 'n/a' });
    expect('cacheSavings' in dropped).toBe(false);
  });
});
