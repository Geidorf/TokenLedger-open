import { describe, expect, it } from 'vitest';
import type { QuotaProviderEnvelope, QuotaWindowSnapshot } from '../../types';
import { quotaWindowParts, selectCompanyQuotaWindows } from '../QuotaPanel';
import { TIER_WORDS, buildCardQuota } from './cardModel';
import { readWidgetQuota } from './quotaRead';

const NOW = Date.now();
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

function percentWindow(
  providerId: string,
  windowId: string,
  windowLabel: string,
  used: number,
  windowMinutes: number,
  extra: Partial<QuotaWindowSnapshot> = {},
): QuotaWindowSnapshot {
  return {
    providerId,
    windowId,
    windowLabel,
    scope: 'consumer-subscription',
    source: 'local-authorized',
    status: 'ok',
    used,
    limit: 100,
    remaining: 100 - used,
    unit: 'percent',
    windowMinutes,
    resetsAt: iso(windowMinutes / 2),
    observedAt: iso(-1),
    fetchedAt: iso(-1),
    staleAfterSeconds: 3600,
    ...extra,
  };
}

function consumer(providerId: string, displayName: string, windows: QuotaWindowSnapshot[]): QuotaProviderEnvelope {
  return {
    schemaVersion: 1,
    providerId,
    displayName,
    scope: 'consumer-subscription',
    mode: 'automatic',
    capability: 'experimental',
    status: 'ok',
    windows,
  };
}

const ANTIGRAVITY = 'google-antigravity-consumer';

/** 公司额度来源（与 dev mock 同形）：契约里有 Key 日额度，看板只显示今日与本月。 */
function company(): QuotaProviderEnvelope {
  const providerId = 'company-openapi-0123456789abcdef01234567';
  const window = (windowId: string, windowLabel: string, used: number, windowMinutes: number): QuotaWindowSnapshot => ({
    providerId,
    windowId,
    windowLabel,
    scope: 'api-organization',
    source: 'official-api',
    status: 'ok',
    used,
    limit: 100,
    remaining: 100 - used,
    unit: 'percent',
    windowMinutes,
    observedAt: iso(-1),
    fetchedAt: iso(-1),
    staleAfterSeconds: 300,
  });
  return {
    schemaVersion: 1,
    providerId,
    displayName: '生产账号',
    scope: 'api-organization',
    mode: 'automatic',
    capability: 'plan-dependent',
    status: 'ok',
    // Key 日额度最吃紧：要是漏过筛选，它会顶到挂件的第一个圆环上。
    windows: [
      window('key-daily', 'Key 今日额度', 95, 1_440),
      window('user-daily', '用户今日额度', 41, 1_440),
      window('user-monthly', '用户本月额度', 58, 43_200),
    ],
  };
}

const CLAUDE = consumer('anthropic-claude-consumer', 'Anthropic Claude', [
  percentWindow('anthropic-claude-consumer', 'five-hour', '5-hour', 87, 300),
]);

describe('挂件读额度', () => {
  it('公司额度来源只留看板显示的「今日」「本月」，不画 Key 日额度（R-52 P2-1）', () => {
    const source = company();
    const read = readWidgetQuota([source, CLAUDE], NOW);
    const own = read.highlights.filter((item) => item.providerId === source.providerId);
    // 按吃紧程度排：本月可用 42% 在今日可用 59% 前面。
    expect(own.map((item) => item.windowId)).toEqual(['user-monthly', 'user-daily']);
    expect(own.map((item) => item.windowLabel)).toEqual(['本月', '今日']);
    // 窗口数与看板一致：看板用的就是同一个 selectCompanyQuotaWindows。
    expect(own).toHaveLength(selectCompanyQuotaWindows(source.windows).length);
    expect(read.highlights).toHaveLength(selectCompanyQuotaWindows(source.windows).length + CLAUDE.windows.length);
    expect(read.highlights.some((item) => item.windowId === 'key-daily')).toBe(false);
    expect([...read.parts.keys()].some((key) => key.endsWith(':key-daily'))).toBe(false);
    expect(read.names.get(source.providerId)).toBe('生产账号');
    // 最紧的一条是 Claude 的 5 小时（可用 13%），不是被筛掉的 Key 日额度（可用 5%）。
    expect(read.highlights[0]).toMatchObject({ providerName: 'Claude', remaining: 13 });
  });

  it('阈值 20 / 50：可用 19% 告急，20% 与 49% 偏紧，50% 充足；按可用升序', () => {
    const windows = [
      percentWindow(ANTIGRAVITY, 'antigravity-gemini-weekly', 'Gemini 每周额度', 50, 10_080),
      percentWindow(ANTIGRAVITY, 'antigravity-claude-gpt-weekly', 'Claude / GPT 每周额度', 81, 10_080),
      percentWindow(ANTIGRAVITY, 'antigravity-gemini-five-hour', 'Gemini 5 小时额度', 80, 300),
      percentWindow(ANTIGRAVITY, 'antigravity-claude-gpt-five-hour', 'Claude / GPT 5 小时额度', 51, 300),
    ];
    const quota = buildCardQuota(readWidgetQuota([consumer(ANTIGRAVITY, 'Antigravity', windows)], NOW), null);
    expect(quota.kind).toBe('ready');
    if (quota.kind !== 'ready') return;
    expect(quota.items.map((item) => [item.available, item.level, TIER_WORDS[item.level]])).toEqual([
      [19, 'critical', '告急'],
      [20, 'warn', '偏紧'],
      [49, 'warn', '偏紧'],
      [50, 'ok', '充足'],
    ]);
  });

  it('窗口名带分组，与看板同名；分组与短名分开存，窄格子只截分组', () => {
    const windows = [
      percentWindow(ANTIGRAVITY, 'antigravity-gemini-weekly', 'Gemini 每周额度', 32, 10_080),
      percentWindow(ANTIGRAVITY, 'antigravity-claude-gpt-weekly', 'Claude / GPT 每周额度', 45, 10_080),
    ];
    const quota = buildCardQuota(readWidgetQuota([consumer(ANTIGRAVITY, 'Antigravity', windows)], NOW), null);
    if (quota.kind !== 'ready') throw new Error('expected ready');
    for (const window of windows) {
      const { groupLabel, label } = quotaWindowParts(window);
      const item = quota.items.find((entry) => entry.key === `${ANTIGRAVITY}:${window.windowId}`);
      expect(item).toMatchObject({ provider: 'Antigravity', group: groupLabel, label, window: `${groupLabel} ${label}` });
    }
    expect(quota.items.map((item) => item.window)).toEqual(['Claude / GPT 每周', 'Gemini 每周']);
  });

  it('额度契约不合法时当作没有可读额度，不抛错、不拖垮统计', () => {
    expect(readWidgetQuota({ not: 'an array' }, NOW)).toMatchObject({ highlights: [] });
    expect(readWidgetQuota([{ providerId: 'broken' }], NOW).highlights).toEqual([]);
    expect(buildCardQuota(readWidgetQuota(null, NOW), null)).toEqual({ kind: 'empty' });
  });
});
