import { describe, expect, it } from 'vitest';
import type { StatsData } from '../types';
import { buildWallpaperSnapshot } from './liveWallpaper';

const stats = (overrides: Partial<StatsData> = {}): StatsData => ({ summary: { totalTokens: 999, inputTokens: 200, outputTokens: 300, cachedTokens: 400, totalCost: 1.25, totalRequests: 3, avgTokensPerReq: 166 }, tools: { Codex: { name: 'Codex', input: 100, output: 200, cached: 300, total: 600, cost: 1, requests: 2 }, Claude: { name: 'Claude', input: 100, output: 100, cached: 100, total: 300, cost: .25, requests: 1 } }, models: {}, trends: [{ date: '09:00', Codex: 300, Claude: 200, __requests: 3 }], heatmap: {}, history: [], ...overrides });

describe('buildWallpaperSnapshot', () => {
  it('固定用输入加输出作为有效 Token，并让缓存保持单列', () => { const snapshot = buildWallpaperSnapshot(stats()); expect(snapshot.effectiveTokens).toBe(500); expect(snapshot.cachedTokens).toBe(400); expect(snapshot.trend).toEqual([500]); });
  it('不把未知成本伪装成零，并忽略趋势保留元数据', () => { const snapshot = buildWallpaperSnapshot(stats({ summary: { ...stats().summary, totalCost: Number.NaN }, trends: [{ date: '10:00', Codex: 20, __requests: 99, __metadata: 20 }] })); expect(snapshot.cost).toBeNull(); expect(snapshot.trend).toEqual([20]); });
});
