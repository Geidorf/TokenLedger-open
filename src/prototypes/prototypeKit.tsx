import type { ReactNode } from 'react';
import { Route } from 'lucide-react';
import { formatTokens } from '../utils/format';

const ICONS = import.meta.glob('./brand-icons/*.svg', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

export type BrandIconId =
  | 'openai' | 'claude-color' | 'anthropic' | 'deepseek-color' | 'openrouter' | 'moonshot' | 'kimi' | 'ollama'
  | 'codex-color' | 'claudecode-color' | 'gemini-color' | 'geminicli-color' | 'qwen-color' | 'zhipu-color'
  | 'xai' | 'mistral-color' | 'groq' | 'siliconcloud-color' | 'opencode' | 'cursor';

export function BrandIcon({ id, fallback, size = 20 }: { id?: BrandIconId | null; fallback?: string; size?: number }) {
  const svg = id ? ICONS[`./brand-icons/${id}.svg`] : undefined;
  if (!svg) {
    return <span className="mw-brand is-fallback" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">{fallback ?? '?'}</span>;
  }
  return <span className="mw-brand" style={{ width: size, height: size }} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function GroupIcon({ size = 20 }: { size?: number }) {
  return <span className="mw-brand is-group" style={{ width: size, height: size }} aria-hidden="true"><Route style={{ width: size * 0.62, height: size * 0.62 }} /></span>;
}

export const CHART_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-7)', 'var(--chart-8)', 'var(--chart-6)'];

export function Seg<T extends string>({ value, options, onChange, label, size = 'md' }: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div className={`mw-seg ${size === 'sm' ? 'is-sm' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" role="radio" aria-checked={value === option.id} className={value === option.id ? 'is-on' : ''} onClick={() => onChange(option.id)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface StackSeries { id: string; label: string; color: string }

export function StackedBars({ labels, series, values, format, height = 200, highlight }: {
  labels: string[];
  series: StackSeries[];
  values: number[][];
  format: (value: number) => string;
  height?: number;
  highlight?: number | null;
}) {
  const totals = values.map((column) => column.reduce((sum, value) => sum + value, 0));
  const max = Math.max(1, ...totals);
  const ticks = [1, 0.75, 0.5, 0.25, 0];
  return (
    <div className="mw-bars" style={{ height }}>
      <div className="mw-bars-axis" aria-hidden="true">
        {ticks.map((tick) => <span key={tick}>{tick === 0 ? '0' : format(max * tick)}</span>)}
      </div>
      <div className="mw-bars-plot">
        <div className="mw-bars-cols">
          {ticks.map((tick) => <span key={tick} className="mw-bars-grid" style={{ bottom: `${tick * 100}%` }} />)}
          {values.map((column, index) => (
            <div key={labels[index]} className={`mw-bars-col ${highlight === index ? 'is-hl' : ''}`} title={`${labels[index]} · ${format(totals[index])}`}>
              <div className="mw-bars-stack" style={{ height: `${(totals[index] / max) * 100}%` }}>
                {column.map((value, seriesIndex) => (value > 0
                  ? <span key={series[seriesIndex].id} style={{ flexGrow: value, background: series[seriesIndex].color }} />
                  : null))}
              </div>
            </div>
          ))}
        </div>
        <div className="mw-bars-x" aria-hidden="true">
          {labels.map((label, index) => <span key={label}>{index % 5 === 0 || index === labels.length - 1 ? label : ''}</span>)}
        </div>
      </div>
    </div>
  );
}

export interface RankRow {
  id: string;
  label: string;
  value: number;
  icon?: ReactNode;
  color?: string;
  meta?: string;
  trailing?: string;
  danger?: string;
}

export function RankList({ rows, format, max, limit = 6, dense = false, columns = false }: {
  rows: RankRow[];
  format: (value: number) => string;
  max?: number;
  limit?: number;
  dense?: boolean;
  columns?: boolean;
}) {
  const top = Math.max(1, max ?? Math.max(...rows.map((row) => row.value)));
  const shown = rows.slice(0, limit);
  const rest = rows.length - shown.length;
  return (
    <div className={`mw-rank ${dense ? 'is-dense' : ''} ${columns ? 'is-cols' : ''}`}>
      {shown.map((row) => (
        <div key={row.id} className="mw-rank-row">
          <div className="mw-rank-head">
            {row.icon ?? (row.color ? <span className="mw-rank-dot" style={{ background: row.color }} /> : null)}
            <span className="mw-rank-label">{row.label}</span>
            <span className="mw-rank-value">{format(row.value)}</span>
            {row.trailing && <span className="mw-rank-trailing">{row.trailing}</span>}
          </div>
          <div className="mw-rank-track"><span style={{ width: `${(row.value / top) * 100}%`, background: row.color ?? 'var(--color-primary)' }} /></div>
          {row.meta && <div className="mw-rank-meta">{row.meta}{row.danger && <em> · {row.danger}</em>}</div>}
        </div>
      ))}
      {rest > 0 && <div className="mw-rank-more">还有 {rest} 项</div>}
    </div>
  );
}

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function HourHeatmap({ grid, caption }: { grid: number[][]; caption: string }) {
  const max = Math.max(1, ...grid.flat());
  return (
    <div className="mw-heat">
      <div className="mw-heat-grid">
        {grid.map((row, day) => (
          <div key={WEEKDAYS[day]} className="mw-heat-row">
            <span className="mw-heat-day">{WEEKDAYS[day]}</span>
            {row.map((value, hour) => {
              const level = value === 0 ? 0 : Math.min(4, Math.ceil((value / max) * 4));
              return <span key={hour} className={`mw-heat-cell is-l${level}`} title={`${WEEKDAYS[day]} ${hour}:00 · ${formatTokens(value)}`} />;
            })}
          </div>
        ))}
        <div className="mw-heat-row is-axis" aria-hidden="true">
          <span className="mw-heat-day" />
          {Array.from({ length: 24 }, (_, hour) => <span key={hour} className="mw-heat-hour">{hour % 6 === 0 ? hour : ''}</span>)}
        </div>
      </div>
      <div className="mw-heat-foot">
        <span>{caption}</span>
        <span className="mw-heat-legend">少{[0, 1, 2, 3, 4].map((level) => <span key={level} className={`mw-heat-cell is-l${level}`} />)}多</span>
      </div>
    </div>
  );
}
