import type { StatsData } from './types';
import { formatTokens } from './utils/format';

/** Browser-only stand-in for the Rust `preview_wallpaper` command. */
export interface MockWallpaperPreview {
  dataUrl: string;
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
}

const SCREEN = { width: 1920, height: 1080 };
const TOOL_COLORS = ['#4ade80', '#a78bfa', '#fb923c', '#60a5fa'];

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Sketches the static wallpaper layout from mock stats, using the same effective = input + output split. */
export function mockWallpaperPreview(stats: StatsData, now: Date): MockWallpaperPreview {
  const effective = stats.summary.inputTokens + stats.summary.outputTokens;
  const hourly = Array.from({ length: 24 }, () => 0);
  for (const row of stats.history) {
    const hour = new Date(row.timestamp).getHours();
    if (Number.isInteger(hour)) hourly[hour] += row.inputTokens + row.outputTokens;
  }
  const peak = Math.max(...hourly, 1);
  const chart = { x: 380, y: 300, w: 1160, h: 220 };
  const points = hourly.slice(0, now.getHours() + 1)
    .map((value, hour) => `${chart.x + (hour / 23) * chart.w},${chart.y + chart.h - (value / peak) * chart.h}`)
    .join(' ');
  const tools = Object.values(stats.tools)
    .map((tool) => ({ name: tool.name, effective: tool.input + tool.output }))
    .sort((left, right) => right.effective - left.effective)
    .slice(0, 4);
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const toolRows = tools.map((tool, index) => {
    const share = effective > 0 ? Math.round((tool.effective / effective) * 100) : 0;
    const y = 640 + index * 40;
    return `<circle cx="1180" cy="${y - 6}" r="7" fill="${TOOL_COLORS[index]}"/>`
      + `<text x="1200" y="${y}" font-size="22" fill="#cbd5e1">${escapeXml(tool.name)}</text>`
      + `<text x="1500" y="${y}" font-size="22" fill="#e2e8f0" text-anchor="end">${share}%</text>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SCREEN.width} ${SCREEN.height}" font-family="-apple-system, 'PingFang SC', sans-serif">`
    + '<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#121826"/><stop offset="1" stop-color="#05070b"/></linearGradient></defs>'
    + `<rect width="${SCREEN.width}" height="${SCREEN.height}" fill="url(#bg)"/>`
    + `<text x="960" y="190" font-size="96" font-weight="300" fill="#f8fafc" text-anchor="middle">${time}</text>`
    + `<line x1="${chart.x}" y1="${chart.y + chart.h}" x2="${chart.x + chart.w}" y2="${chart.y + chart.h}" stroke="#334155" stroke-width="2"/>`
    + (points ? `<polyline points="${points}" fill="none" stroke="#5b8def" stroke-width="5" stroke-linejoin="round"/>` : '')
    + '<rect x="320" y="580" width="1280" height="220" rx="28" fill="#1e2330" fill-opacity="0.85"/>'
    + '<text x="380" y="640" font-size="24" fill="#94a3b8">有效 Token</text>'
    + `<text x="380" y="720" font-size="72" font-weight="300" fill="#f8fafc">${escapeXml(formatTokens(effective))}</text>`
    + '<text x="760" y="640" font-size="24" fill="#94a3b8">记录数</text>'
    + `<text x="760" y="720" font-size="72" font-weight="300" fill="#f8fafc">${stats.summary.totalRequests}</text>`
    + toolRows
    + '<text x="960" y="1010" font-size="22" fill="#64748b" text-anchor="middle">开发预览示意图 · 桌面版由原生渲染器生成</text>'
    + '</svg>';
  return {
    dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    width: 960,
    height: 540,
    screenWidth: SCREEN.width,
    screenHeight: SCREEN.height,
  };
}
