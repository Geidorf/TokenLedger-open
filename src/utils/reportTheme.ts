import type { ShareLayoutKey } from './shareSummary';

/** Inline, asset-free companions to the five existing poster directions. */
export const DIGEST_THEMES = {
  scorecard: { name: '编辑宣言', issue: 'THE COLLABORATION ISSUE', paper: '#f6f3ed', ink: '#1a1918', accent: '#d92020', cover: '#ff3029', coverInk: '#171717' },
  journal: { name: 'AI 搭子', issue: 'NOTES WITH MY AI', paper: '#f8f7ee', ink: '#182b3b', accent: '#064cff', cover: '#e8ee65', coverInk: '#153020' },
  achievement: { name: '流光档案', issue: 'AN ARCHIVE IN MOTION', paper: '#eff3f7', ink: '#16354d', accent: '#205b83', cover: '#082c45', coverInk: '#e1f1fc' },
  receipt: { name: '月度通行证', issue: 'YOUR COLLABORATION PASS', paper: '#f8edf3', ink: '#3b1830', accent: '#b32668', cover: '#ff80b8', coverInk: '#331328' },
  signal: { name: '像素存档', issue: 'SAVE / COLLABORATION LOG', paper: '#eaf0e5', ink: '#16382b', accent: '#286445', cover: '#bfd0ac', coverInk: '#0b3427' },
} as const satisfies Record<ShareLayoutKey, { name: string; issue: string; paper: string; ink: string; accent: string; cover: string; coverInk: string }>;

export const DIGEST_STYLES = `
* { box-sizing: border-box; margin: 0; padding: 0; }
:root { color-scheme: light; --surface: #fffefa; --border: #d3d6d1; --text-muted: #55616c; --accent-soft: #e7ede7; --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC", sans-serif; }
body { background: var(--paper); color: var(--text); font-family: var(--font-sans); line-height: 1.6; padding: 40px 24px; }
.report-container { max-width: 1080px; margin: auto; }
.file-note { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 24px; margin-bottom: 14px; color: var(--text-muted); font-size: 12px; }
.report-header { position: relative; isolation: isolate; overflow: hidden; display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(220px, 1fr); gap: 40px; padding: 42px; background: var(--cover); color: var(--cover-ink); border: 1px solid currentColor; }
.report-header > :not(.cover-art) { position: relative; z-index: 1; }
.cover-art { position: absolute; right: -90px; bottom: -190px; width: 390px; height: 390px; border: 70px solid currentColor; border-radius: 50%; opacity: .1; pointer-events: none; }
.brand-kicker { font-size: 15px; font-weight: 800; letter-spacing: .03em; }
.edition { display: block; font: 11px/1.5 var(--font-mono); letter-spacing: .12em; margin-top: 22px; }
.brand-title { font-size: clamp(30px, 4.4vw, 54px); line-height: 1.17; letter-spacing: -.04em; margin: 12px 0 18px; max-width: 680px; overflow-wrap: anywhere; }
.brand-sub { font-size: 12px; max-width: 40em; opacity: .85; }
.report-meta { align-self: end; font-size: 12px; line-height: 1.85; overflow-wrap: anywhere; }
.badge { display: block; font-weight: 750; font-size: 14px; margin-bottom: 8px; }
.hidden-costs-badge { display: inline-block; border: 1px solid currentColor; padding: 3px 10px; margin-bottom: 12px; font-weight: 700; }
.kpi-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid var(--border); background: var(--border); gap: 1px; margin: 24px 0; }
.kpi-card { min-width: 0; background: var(--surface); padding: 22px 26px; }
.kpi-card-primary { grid-column: 1 / -1; padding: 32px; }
.kpi-label { font-size: 13px; font-weight: 650; color: var(--text-muted); }
.kpi-value { font: 750 clamp(24px, 3vw, 36px)/1.2 var(--font-mono); letter-spacing: -.045em; margin-top: 9px; overflow-wrap: anywhere; }
.kpi-card-primary .kpi-value { color: var(--accent); font-size: clamp(48px, 10vw, 108px); font-weight: 850; line-height: 1.05; }
.kpi-sub, .kpi-delta { color: var(--text-muted); font-size: 12px; margin-top: 8px; overflow-wrap: anywhere; }
.exact-value { font-variant-numeric: tabular-nums; }
.cache-observation { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 16px 30px; border-block: 1px solid var(--border); padding: 20px 0; }
.observation-title { font-size: 15px; font-weight: 750; }
.observation-desc { font-size: 13px; color: var(--text-muted); margin-top: 4px; max-width: 65em; }
.observation-facts { font-size: 13px; color: var(--accent); font-weight: 650; }
.section-title { display: flex; align-items: center; gap: 14px; font-size: 20px; letter-spacing: -.02em; margin: 38px 0 12px; }
.section-title::before { content: ''; width: 7px; height: 24px; background: var(--accent); flex: 0 0 auto; }
.table-container { background: var(--surface); border: 1px solid var(--border); overflow-x: auto; margin-bottom: 24px; }
.table-container:focus-visible { outline: 3px solid var(--accent); outline-offset: 4px; }
table { width: 100%; min-width: 760px; border-collapse: collapse; font-size: 13px; text-align: left; }
th { background: var(--paper); color: var(--text-muted); font-size: 11px; font-weight: 650; }
th, td { padding: 15px 18px; border-bottom: 1px solid var(--border); vertical-align: top; }
tr:last-child td { border-bottom: none; }
.num { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.name-cell { width: 25%; min-width: 200px; max-width: 320px; font-weight: 650; overflow-wrap: anywhere; word-break: break-word; }
.name-cell > span:first-child { display: block; }
.rank-bar { display: block; height: 3px; width: 100%; margin-top: 9px; background: var(--accent-soft); overflow: hidden; }
.rank-bar i { display: block; height: 100%; background: var(--accent); }
.cost-cell { color: var(--text); font-weight: 650; }
.report-footer { display: grid; gap: 8px; border-top: 2px solid var(--text); padding: 22px 0 12px; margin-top: 36px; color: var(--text-muted); font-size: 12px; overflow-wrap: anywhere; }
.report-footer strong { color: var(--text); font-size: 15px; }
[data-layout="journal"] .cover-art { opacity: 1; border: none; background: #ff9bd7; border-radius: 0; transform: rotate(-18deg); width: 160px; height: 160px; bottom: -100px; right: 18%; }
[data-layout="journal"] .kpi-card-primary { border-left: 12px solid #064cff; }
[data-layout="achievement"] .cover-art { border-width: 30px; opacity: .24; width: 370px; height: 170px; transform: rotate(-27deg); bottom: -110px; right: -35px; }
[data-layout="receipt"] .report-header { border-bottom: 3px dashed var(--cover-ink); }
[data-layout="receipt"] .edition { letter-spacing: .2em; }
[data-layout="signal"] .brand-title, [data-layout="signal"] .edition { font-family: var(--font-mono); }
[data-layout="signal"] .cover-art { border-radius: 0; border-width: 32px; width: 150px; height: 150px; right: -75px; bottom: -75px; transform: rotate(45deg); opacity: .3; }
@media (max-width: 740px) { body { padding: 20px 14px; } .report-header { grid-template-columns: minmax(0, 1fr); gap: 26px; padding: 28px 24px; } .kpi-grid { grid-template-columns: minmax(0, 1fr); } .kpi-card-primary { padding: 26px; } .kpi-value { font-size: 32px; } .section-title { font-size: 18px; } }
@media print {
 @page { margin: 14mm; }
 :root { --paper: #fff !important; --surface: #fff !important; --text: #172033 !important; --text-muted: #475569 !important; --accent: #172033 !important; --border: #b7bec8 !important; --cover: #fff !important; --cover-ink: #172033 !important; }
 body { padding: 0; background: #fff; color: #172033; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
 .file-note, .cover-art { display: none; } .report-header { padding: 18px; grid-template-columns: 1fr; gap: 14px; } .brand-title { font-size: 30px; }
 .kpi-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } .kpi-card { padding: 12px; } .kpi-card-primary .kpi-value { font-size: 58px; }
 .table-container { overflow: visible; }
 table { min-width: 0; table-layout: fixed; font-size: 9px; } .name-cell { min-width: 0; width: 25%; } th, td { padding: 7px; overflow-wrap: anywhere; }
 .section-title { break-after: avoid; } .kpi-card, tr, .cache-observation { break-inside: avoid; } thead { display: table-header-group; }
}
`;
