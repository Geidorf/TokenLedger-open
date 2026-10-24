import { escapeHtml } from './frontendContracts';
import { formatEstimatedUsd, formatNum, formatTokens } from './format';
import { ESTIMATED_COST_NOTE } from './costCopy';
import { DIGEST_STYLES } from './reportTheme';
import { budgetScopeName } from '../components/settings/BudgetSection';
import { BUDGET_METRIC_LABELS } from '../hooks/useBudget';
import { ensureShareCardAssetsReady, SHARE_FONT_FAMILIES } from './shareCardRenderer';
import {
  describeDelta,
  reportFileSlug,
  reportTitle,
  type PeriodReport,
  type ReportBreakdownRow,
  type ReportBudget,
  type ReportDelta,
} from './periodReport';

/**
 * 周报 / 月报的三种导出：单文件 HTML（沿用简报的版式与样式表）、打印成 PDF（同一份 HTML
 * 交给系统打印，选「另存为 PDF」）、分享图片（1080×1350 PNG，沿用分享海报的字体）。
 * 三者只读 `buildPeriodReport` 的结果，不各自重算。
 */

export interface PeriodReportExportOptions {
  /** 与分享弹窗「隐藏费用」同一约定：费用、费用占比一律不写入文件。 */
  hideCosts?: boolean;
  appVersion?: string;
}

const BUDGET_LEVEL_TEXT: Record<ReportBudget['level'], string> = {
  ok: '达成',
  warn: '接近上限',
  over: '已超出',
  unavailable: '不可得',
};

function percentText(value: number | null, digits = 1): string {
  return value === null ? '不可得' : `${(value * 100).toFixed(digits)}%`;
}

function costText(value: number | null, hideCosts: boolean): string {
  if (value === null) return '不可得';
  return hideCosts ? '已隐藏' : formatEstimatedUsd(value);
}

function deltaText(delta: ReportDelta): string {
  return describeDelta(delta) ?? '—';
}

function budgetAmount(budget: ReportBudget, value: number | null, hideCosts: boolean): string {
  if (budget.rule.metric === 'cost') return costText(value, hideCosts);
  return value === null ? '不可得' : formatTokens(value);
}

/** 费用预算的比例由金额算出，隐藏费用时一并隐藏（GLB-12）；Token 预算照常显示。 */
export function budgetPercentText(budget: ReportBudget, hideCosts: boolean): string {
  if (budget.percent === null) return '—';
  if (hideCosts && budget.rule.metric === 'cost') return '已隐藏';
  return `${Math.floor(budget.percent)}%`;
}

function shortSessionId(id: string): string {
  return id.length > 10 ? `…${id.slice(-6)}` : id;
}

function breakdownTable(title: string, rows: ReportBreakdownRow[], hideCosts: boolean): string {
  if (rows.length === 0) return '';
  const body = rows.map((row) => `
        <tr>
          <td class="name-cell"><span>${escapeHtml(row.name)}</span><span class="rank-bar" aria-hidden="true"><i style="width:${row.share === null ? 0 : Math.min(100, row.share * 100).toFixed(1)}%"></i></span></td>
          <td class="num">${row.tokens === null ? '不可得' : formatTokens(row.tokens)}</td>
          <td class="num">${percentText(row.share)}</td>
          <td class="num">${formatNum(row.requests)}</td>
          <td class="num cost-cell">${costText(row.cost, hideCosts)}</td>
          <td class="num">${escapeHtml(deltaText(row.delta))}</td>
        </tr>`).join('');
  return `
      <h2 class="section-title">${escapeHtml(title)}</h2>
      <div class="table-container" tabindex="0" role="region" aria-label="${escapeHtml(title)}">
        <table>
          <thead><tr><th scope="col">名称</th><th scope="col" class="num">有效 Token</th><th scope="col" class="num">占比</th><th scope="col" class="num">记录</th><th scope="col" class="num">预估费用</th><th scope="col" class="num">与上期比</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
}

const REPORT_EXTRA_STYLES = `
.highlights { list-style: none; display: grid; gap: 6px; margin: 4px 0 8px; font-size: 14px; }
.highlights li::before { content: '— '; color: var(--accent); font-weight: 800; }
.day-bars { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); align-items: end; gap: 4px; height: 120px; padding: 16px 18px 0; background: var(--surface); border: 1px solid var(--border); }
.day-bars span { display: block; background: var(--accent); min-height: 2px; }
.day-labels { display: flex; justify-content: space-between; padding: 6px 18px 14px; background: var(--surface); border: 1px solid var(--border); border-top: none; color: var(--text-muted); font-size: 11px; margin-bottom: 24px; }
.note { color: var(--text-muted); font-size: 12px; margin: -16px 0 24px; }
`;

export function generatePeriodReportHtml(report: PeriodReport, options: PeriodReportExportOptions = {}): string {
  const hideCosts = options.hideCosts ?? false;
  const { period, totals, deltas } = report;
  const title = reportTitle(period);
  const scopeName = report.scope === 'cloud' ? '已同步账本' : '本机账本';
  const maxDay = Math.max(1, ...report.days.map((day) => day.tokens));
  const dayBars = report.days.map((day) => `<span title="${escapeHtml(day.date)} ${escapeHtml(formatTokens(day.tokens))}" style="height:${((day.tokens / maxDay) * 100).toFixed(1)}%"></span>`).join('');
  const cachePoints = deltas.cacheReusePoints;
  const sessionRows = (report.sessions || []).map((session, index) => `
        <tr>
          <td class="name-cell"><span>#${index + 1} ${escapeHtml(session.tool)}</span><span style="color:var(--text-muted);font-size:11px">${escapeHtml(shortSessionId(session.id))}${session.model ? ` · ${escapeHtml(session.model)}` : ''}</span></td>
          <td class="num cost-cell">${costText(session.cost, hideCosts)}</td>
          <td class="num">${formatTokens(session.tokens)}</td>
          <td class="num">${formatNum(session.requests)}</td>
          <td class="num">${escapeHtml(session.firstAt ? session.firstAt.slice(5, 16) : '—')}</td>
        </tr>`).join('');
  const quotaRows = report.quotas.map((quota) => `
        <tr>
          <td class="name-cell">${escapeHtml(quota.provider)}</td>
          <td>${escapeHtml(quota.window)}</td>
          <td class="num">${quota.remaining}%${quota.stale ? '（历史读数）' : ''}</td>
          <td class="num">${escapeHtml(quota.resetsAt ? new Date(quota.resetsAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')}</td>
        </tr>`).join('');
  const budgetRows = report.budgets.map((budget) => `
        <tr>
          <td class="name-cell">${escapeHtml(budgetScopeName(budget.rule))} · ${escapeHtml(BUDGET_METRIC_LABELS[budget.rule.metric])}</td>
          <td class="num">${budgetAmount(budget, budget.used, hideCosts)}</td>
          <td class="num">${budgetAmount(budget, budget.rule.limit, hideCosts)}</td>
          <td class="num">${budgetPercentText(budget, hideCosts)}</td>
          <td class="num">${BUDGET_LEVEL_TEXT[budget.level]}</td>
        </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TokenLedger ${escapeHtml(title)}</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
  <meta name="color-scheme" content="light">
  <style>:root { --paper: #f4f4f6; --text: #18181b; --accent: #4f46e5; --cover: #4f46e5; --cover-ink: #ffffff; }
${DIGEST_STYLES}
${REPORT_EXTRA_STYLES}</style>
</head>
<body data-layout="report">
  <div class="report-container">
    <div class="file-note"><span>${period.kind === 'week' ? 'WEEKLY' : 'MONTHLY'} REPORT</span><span>单文件报告 · 可离线阅读 · 可打印为 PDF</span></div>
    <header class="report-header">
      <div class="cover-art" aria-hidden="true"></div>
      <div>
        <div class="brand-kicker">TokenLedger</div>
        <span class="edition">${escapeHtml(period.shortLabel)}${period.complete ? '' : ' · 进行中'}</span>
        <h1 class="brand-title">${escapeHtml(title)}</h1>
        <p class="brand-sub">${escapeHtml(period.start)} 至 ${escapeHtml(period.end)}，对比 ${escapeHtml(period.previousLabel)}（${escapeHtml(period.previousStart)} 至 ${escapeHtml(period.previousEnd)}）</p>
      </div>
      <div class="report-meta">
        <span class="badge">${escapeHtml(scopeName)}</span>
        ${hideCosts ? '<span class="hidden-costs-badge">费用已隐藏</span>' : ''}
        <div>活跃 ${totals.activeDays} 天</div>
        <div>生成时间：${escapeHtml(new Date(report.generatedAt).toLocaleString('zh-CN'))}</div>
        ${options.appVersion ? `<div>客户端版本：v${escapeHtml(options.appVersion)}</div>` : ''}
      </div>
    </header>
    <main>
      <div class="kpi-grid">
        <div class="kpi-card kpi-card-primary">
          <div class="kpi-label">有效 Token（输入 + 输出）</div>
          <div class="kpi-value exact-value">${formatTokens(totals.effectiveTokens)}</div>
          <div class="kpi-delta">与${escapeHtml(period.previousLabel)}比 ${escapeHtml(deltaText(deltas.tokens))}</div>
        </div>
        <div class="kpi-card"><div class="kpi-label">预估费用</div><div class="kpi-value">${costText(totals.cost, hideCosts)}</div><div class="kpi-delta">${hideCosts ? '费用已隐藏' : `与上期比 ${escapeHtml(deltaText(deltas.cost))}`}</div></div>
        <div class="kpi-card"><div class="kpi-label">记录数</div><div class="kpi-value">${formatNum(totals.requests)}</div><div class="kpi-delta">与上期比 ${escapeHtml(deltaText(deltas.requests))}</div></div>
        <div class="kpi-card"><div class="kpi-label">缓存复用率</div><div class="kpi-value">${percentText(totals.cacheReuse)}</div><div class="kpi-delta">${cachePoints === null ? '缓存另列，不计入有效 Token' : `${cachePoints >= 0 ? '+' : '−'}${Math.abs(cachePoints).toFixed(1)} 个百分点`}</div></div>
      </div>
      ${report.highlights.length ? `<ul class="highlights">${report.highlights.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : ''}
      <h2 class="section-title">每日有效 Token</h2>
      <div class="day-bars" aria-hidden="true">${dayBars}</div>
      <div class="day-labels"><span>${escapeHtml(period.start)}</span><span>${report.peakDay ? `峰值 ${escapeHtml(report.peakDay.date)} · ${escapeHtml(formatTokens(report.peakDay.tokens))}` : '暂无用量'}</span><span>${escapeHtml(period.end)}</span></div>
      ${breakdownTable('按 Agent', report.agents, hideCosts)}
      ${breakdownTable('按模型', report.models, hideCosts)}
      ${report.accounts ? breakdownTable('按账号', report.accounts, hideCosts) : ''}
      ${report.sessions && report.sessions.length ? `
      <h2 class="section-title">最贵的会话</h2>
      <div class="table-container" tabindex="0" role="region" aria-label="最贵的会话">
        <table>
          <thead><tr><th scope="col">会话</th><th scope="col" class="num">预估费用</th><th scope="col" class="num">有效 Token</th><th scope="col" class="num">记录</th><th scope="col" class="num">开始</th></tr></thead>
          <tbody>${sessionRows}</tbody>
        </table>
      </div>` : ''}
      ${report.sessionsNote ? `<p class="note">${escapeHtml(report.sessionsNote)}</p>` : ''}
      ${report.budgets.length ? `
      <h2 class="section-title">预算达成</h2>
      <div class="table-container" tabindex="0" role="region" aria-label="预算达成">
        <table>
          <thead><tr><th scope="col">预算</th><th scope="col" class="num">已用</th><th scope="col" class="num">上限</th><th scope="col" class="num">比例</th><th scope="col" class="num">结果</th></tr></thead>
          <tbody>${budgetRows}</tbody>
        </table>
      </div>` : ''}
      ${report.quotas.length ? `
      <h2 class="section-title">额度使用（生成时读数）</h2>
      <div class="table-container" tabindex="0" role="region" aria-label="额度使用">
        <table>
          <thead><tr><th scope="col">来源</th><th scope="col">窗口</th><th scope="col" class="num">可用</th><th scope="col" class="num">重置</th></tr></thead>
          <tbody>${quotaRows}</tbody>
        </table>
      </div>` : ''}
    </main>
    <footer class="report-footer">
      <strong>TokenLedger</strong>
      <p>有效 Token = 输入 + 输出；缓存读写另列。不可得表示来源未提供可靠数据，已知零值仍为 0。</p>
      <p>预估费用${ESTIMATED_COST_NOTE}。</p>
      <p>${hideCosts ? '费用已隐藏：费用与费用变化均未写入文件。' : '本文件含预估费用，转发前请确认分享范围。'} 文件只含统计摘要，不含账户、设备标识、会话内容或项目数据。</p>
    </footer>
  </div>
</body>
</html>`;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function periodReportFileName(report: PeriodReport, extension: 'html' | 'png'): string {
  return `tokenledger-${reportFileSlug(report.period)}.${extension}`;
}

export function downloadPeriodReportHtml(report: PeriodReport, options: PeriodReportExportOptions = {}): void {
  triggerDownload(new Blob([generatePeriodReportHtml(report, options)], { type: 'text/html;charset=utf-8' }), periodReportFileName(report, 'html'));
}

/**
 * 打印成 PDF：把同一份 HTML 放进隐藏 iframe 调起系统打印，用户在对话框里选「另存为 PDF」。
 * 不引入 PDF 依赖；简报样式表已带 `@media print` 版式。
 */
export function printPeriodReport(report: PeriodReport, options: PeriodReportExportOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    frame.onload = () => {
      try {
        const view = frame.contentWindow;
        if (!view) throw new Error('无法打开打印预览');
        view.focus();
        view.print();
        resolve();
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        setTimeout(() => frame.remove(), 60_000);
      }
    };
    frame.srcdoc = generatePeriodReportHtml(report, options);
    document.body.appendChild(frame);
  });
}

// -------------------------------------------------------------
// 分享图片
// -------------------------------------------------------------

export const REPORT_IMAGE_WIDTH = 1080;
export const REPORT_IMAGE_HEIGHT = 1350;

const IMAGE_PALETTE = {
  page: '#f4f4f6',
  card: '#ffffff',
  line: '#e3e3e8',
  text: '#18181b',
  muted: '#52525b',
  faint: '#71717a',
  accent: '#4f46e5',
  accentSoft: '#e0e7ff',
  up: '#b45309',
  down: '#047857',
  series: ['#4f46e5', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899', '#a1a1aa'],
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function text(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, size: number, color: string, weight = 500, align: CanvasTextAlign = 'left', family: string = SHARE_FONT_FAMILIES.sans, maxWidth?: number): void {
  ctx.font = `${weight} ${size}px ${family}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  let shown = value;
  if (maxWidth && ctx.measureText(shown).width > maxWidth) {
    while (shown.length > 1 && ctx.measureText(`${shown}…`).width > maxWidth) shown = shown.slice(0, -1);
    shown = `${shown}…`;
  }
  ctx.fillText(shown, x, y);
}

function deltaColor(delta: ReportDelta): string {
  if (delta.kind !== 'change') return IMAGE_PALETTE.muted;
  return delta.percent > 0 ? IMAGE_PALETTE.up : IMAGE_PALETTE.down;
}

export function renderPeriodReportImage(report: PeriodReport, options: PeriodReportExportOptions = {}): HTMLCanvasElement {
  const hideCosts = options.hideCosts ?? true;
  const canvas = document.createElement('canvas');
  canvas.width = REPORT_IMAGE_WIDTH;
  canvas.height = REPORT_IMAGE_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建报告画布，请重试');
  const p = IMAGE_PALETTE;
  const { period, totals, deltas } = report;
  const W = REPORT_IMAGE_WIDTH;
  const M = 64;

  ctx.fillStyle = p.page;
  ctx.fillRect(0, 0, W, REPORT_IMAGE_HEIGHT);
  // 顶部强调条与刊头
  ctx.fillStyle = p.accent;
  ctx.fillRect(0, 0, W, 12);
  text(ctx, 'TokenLedger', M, 96, 30, p.accent, 800);
  text(ctx, report.scope === 'cloud' ? '已同步账本' : '本机账本', W - M, 96, 26, p.faint, 500, 'right');
  text(ctx, period.kind === 'week' ? '用量周报' : '用量月报', M, 178, 72, p.text, 900);
  text(ctx, `${period.label}${period.complete ? '' : ' · 进行中'}`, M, 230, 32, p.muted, 600);

  // 主数字卡
  roundRect(ctx, M, 270, W - M * 2, 250, 24, p.card, p.line);
  text(ctx, '有效 Token', M + 40, 328, 28, p.muted, 600);
  text(ctx, formatTokens(totals.effectiveTokens), M + 40, 452, 120, p.accent, 900, 'left', SHARE_FONT_FAMILIES.number);
  const tokenDelta = describeDelta(deltas.tokens);
  if (tokenDelta) {
    text(ctx, `${tokenDelta}`, W - M - 40, 420, 48, deltaColor(deltas.tokens), 800, 'right', SHARE_FONT_FAMILIES.number);
    text(ctx, `对比${period.previousLabel}`, W - M - 40, 462, 24, p.faint, 500, 'right');
  }
  text(ctx, `活跃 ${totals.activeDays} 天 · ${formatNum(totals.requests)} 条记录`, M + 40, 496, 24, p.faint, 500);

  // 三个小格
  const tiles: Array<[string, string, string]> = [
    ['预估费用', costText(totals.cost, hideCosts), hideCosts ? '已隐藏' : deltaText(deltas.cost)],
    ['缓存复用率', percentText(totals.cacheReuse), deltas.cacheReusePoints === null ? '缓存另列' : `${deltas.cacheReusePoints >= 0 ? '+' : '−'}${Math.abs(deltas.cacheReusePoints).toFixed(1)} pt`],
    ['预算', report.budgets.length === 0 ? '未设置' : `${report.budgets.filter((b) => b.level === 'ok').length}/${report.budgets.length} 达成`, report.budgets.some((b) => b.level === 'over') ? '有超出' : ' '],
  ];
  const tileW = (W - M * 2 - 32) / 3;
  tiles.forEach(([label, value, sub], index) => {
    const x = M + index * (tileW + 16);
    roundRect(ctx, x, 544, tileW, 170, 20, p.card, p.line);
    text(ctx, label, x + 28, 594, 24, p.muted, 600);
    text(ctx, value, x + 28, 656, 44, p.text, 800, 'left', SHARE_FONT_FAMILIES.number, tileW - 56);
    text(ctx, sub, x + 28, 692, 22, p.faint, 500, 'left', SHARE_FONT_FAMILIES.sans, tileW - 56);
  });

  // 每日柱
  roundRect(ctx, M, 738, W - M * 2, 230, 20, p.card, p.line);
  text(ctx, '每日有效 Token', M + 28, 784, 24, p.muted, 600);
  const maxDay = Math.max(1, ...report.days.map((day) => day.tokens));
  const chartX = M + 28;
  const chartW = W - M * 2 - 56;
  const gap = report.days.length > 14 ? 4 : 14;
  const barW = Math.max(4, (chartW - gap * (report.days.length - 1)) / Math.max(1, report.days.length));
  report.days.forEach((day, index) => {
    const h = Math.max(3, (day.tokens / maxDay) * 130);
    const isPeak = report.peakDay?.date === day.date;
    roundRect(ctx, chartX + index * (barW + gap), 940 - h, barW, h, Math.min(6, barW / 2), isPeak ? p.accent : p.accentSoft);
  });

  // Agent 拆分
  roundRect(ctx, M, 992, W - M * 2, 250, 20, p.card, p.line);
  text(ctx, '按 Agent', M + 28, 1038, 24, p.muted, 600);
  const agents = report.agents.slice(0, 4);
  let cursor = M + 28;
  const stackW = W - M * 2 - 56;
  report.agents.forEach((row, index) => {
    const w = (row.share ?? 0) * stackW;
    if (w <= 0) return;
    ctx.fillStyle = p.series[Math.min(index, p.series.length - 1)];
    ctx.fillRect(cursor, 1062, w, 22);
    cursor += w;
  });
  agents.forEach((row, index) => {
    const y = 1130 + index * 32;
    ctx.fillStyle = p.series[Math.min(index, p.series.length - 1)];
    ctx.fillRect(M + 28, y - 18, 18, 18);
    text(ctx, row.name, M + 58, y, 24, p.text, 600, 'left', SHARE_FONT_FAMILIES.sans, 520);
    text(ctx, row.tokens === null ? '不可得' : `${formatTokens(row.tokens)} · ${percentText(row.share, 0)}`, W - M - 28, y, 24, p.muted, 600, 'right', SHARE_FONT_FAMILIES.number);
  });
  if (agents.length === 0) text(ctx, '本期没有用量', M + 28, 1140, 24, p.faint);

  text(ctx, '有效 Token = 输入 + 输出，缓存另列 · 预估费用按本机价格表估算', M, 1292, 20, p.faint);
  text(ctx, `生成于 ${new Date(report.generatedAt).toLocaleDateString('zh-CN')}`, W - M, 1292, 20, p.faint, 500, 'right');
  return canvas;
}

export async function downloadPeriodReportImage(report: PeriodReport, options: PeriodReportExportOptions = {}): Promise<void> {
  await ensureShareCardAssetsReady('scorecard');
  const canvas = renderPeriodReportImage(report, options);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('图片生成失败'))), 'image/png'));
  triggerDownload(blob, periodReportFileName(report, 'png'));
}
