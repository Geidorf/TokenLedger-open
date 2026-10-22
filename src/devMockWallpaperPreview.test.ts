import { describe, expect, it } from 'vitest';
import type { StatsData } from './types';
import { mockWallpaperPreview } from './devMockWallpaperPreview';

function stats(): StatsData {
  const row = (tool: string, hour: number, inputTokens: number, outputTokens: number, cachedTokens: number) => ({
    tool, timestamp: new Date(2026, 6, 15, hour, 10).toISOString(), inputTokens, outputTokens, cachedTokens,
  });
  return {
    summary: { inputTokens: 1_200_000, outputTokens: 300_000, cachedTokens: 9_000_000, totalRequests: 42 },
    tools: {
      claude: { name: 'claude', input: 900_000, output: 200_000, cached: 8_000_000 },
      codex: { name: 'codex', input: 300_000, output: 100_000, cached: 1_000_000 },
    },
    history: [row('claude', 9, 900_000, 200_000, 8_000_000), row('codex', 13, 300_000, 100_000, 1_000_000)],
  } as unknown as StatsData;
}

describe('mockWallpaperPreview', () => {
  it('以 16:9 示意图呈现有效 Token（输入 + 输出，不含缓存）', () => {
    const preview = mockWallpaperPreview(stats(), new Date(2026, 6, 15, 14, 30));
    expect(preview).toMatchObject({ width: 960, height: 540, screenWidth: 1920, screenHeight: 1080 });
    expect(preview.dataUrl.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    const svg = decodeURIComponent(preview.dataUrl.split(',')[1]);
    expect(svg).toContain('>1.50M<');
    expect(svg).not.toContain('10.50M');
    expect(svg).toContain('14:30');
    expect(svg).toContain('>73%<');
  });
});
