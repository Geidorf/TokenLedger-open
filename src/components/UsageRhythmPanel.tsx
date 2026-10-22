import { memo, useId, useRef, useState, type CSSProperties, type FocusEvent, type MouseEvent } from 'react';
import { CalendarDays, Clock } from 'lucide-react';
import { formatEstimatedUsd, formatNum, formatTokens } from '../utils/format';
import { describeRhythmDelta, rhythmLevel, type Rhythm, type RhythmCell } from '../utils/insightRules';
import { InfoTip } from './InfoTip';

interface UsageRhythmPanelProps {
  rhythm: Rhythm;
}

interface ActiveCell {
  index: number;
  /** 相对 `.rhythm-strip-wrap` 的锚点（格子顶部中点），像素。 */
  left: number;
  top: number;
}

const TOOLTIP_HALF_WIDTH = 104;

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** 悬浮详情卡（T10.111）：只渲染有数据的行，缺来源的行不占位、不写 0。 */
function RhythmTooltip({ cell, id, mode }: { cell: RhythmCell; id: string; mode: Rhythm['mode'] }) {
  const detail = cell.detail ?? null;
  const delta = detail ? describeRhythmDelta(detail.tokens, detail.previousTokens) : null;
  const trend = delta === null ? null : delta.startsWith('+') || delta === '新增' ? 'up' : delta.startsWith('−') ? 'down' : 'flat';
  return (
    <div className="rhythm-tooltip" role="tooltip" id={id}>
      <div className="rhythm-tooltip-head">
        <strong>{detail?.range ?? cell.key}</strong>
        {cell.state === 'in-progress' && <span className="rhythm-tooltip-flag">进行中</span>}
        {cell.state === 'future' && <span className="rhythm-tooltip-flag is-muted">尚未开始</span>}
      </div>
      {detail ? (
        <>
          <div className="rhythm-tooltip-value">
            <b>{formatTokens(detail.tokens)}</b>
            <span>{mode === 'hour' ? '有效 Token' : '日均有效 Token'}</span>
          </div>
          <dl className="rhythm-tooltip-grid">
            {detail.share !== null && (<><dt>{detail.shareLabel}</dt><dd>{percent(detail.share)}</dd></>)}
            {detail.cost !== null && (<><dt>预估费用</dt><dd>{formatEstimatedUsd(detail.cost)}</dd></>)}
            {detail.requests !== null && (<><dt>请求</dt><dd>{formatNum(detail.requests)} 次</dd></>)}
            {detail.previousTokens !== null && (
              <>
                <dt>{detail.previousLabel}</dt>
                <dd>
                  {formatTokens(detail.previousTokens)}
                  {delta && <em data-trend={trend ?? 'flat'}>{delta}</em>}
                </dd>
              </>
            )}
            {detail.topTool && (<><dt>主要来源</dt><dd>{detail.topTool.name} · {percent(detail.topTool.share)}</dd></>)}
            {detail.note && (<><dt>观测</dt><dd>{detail.note}</dd></>)}
          </dl>
        </>
      ) : (
        <p className="rhythm-tooltip-empty">
          {cell.state === 'future' ? '这个时段还没到，不计入本期总量。' : '观测窗口内没有这个时段的数据。'}
        </p>
      )}
    </div>
  );
}

function UsageRhythmPanelComponent({ rhythm }: UsageRhythmPanelProps) {
  const [active, setActive] = useState<ActiveCell | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const max = rhythm.cells.reduce((best, cell) => (cell.state === 'future' ? best : Math.max(best, cell.value)), 0);
  const activeCell = active ? rhythm.cells[active.index] : null;

  const activate = (index: number, target: HTMLElement) => {
    const wrap = wrapRef.current?.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const width = wrap?.width ?? 0;
    const rawLeft = wrap ? rect.left - wrap.left + rect.width / 2 : 0;
    const left = width > TOOLTIP_HALF_WIDTH * 2
      ? Math.min(width - TOOLTIP_HALF_WIDTH, Math.max(TOOLTIP_HALF_WIDTH, rawLeft))
      : rawLeft;
    setActive({ index, left, top: wrap ? rect.top - wrap.top : 0 });
  };
  const onEnter = (index: number) => (event: MouseEvent<HTMLDivElement>) => activate(index, event.currentTarget);
  const onFocus = (index: number) => (event: FocusEvent<HTMLDivElement>) => activate(index, event.currentTarget);
  const onBlur = (index: number) => () => setActive((current) => (current?.index === index ? null : current));
  const anchorStyle: CSSProperties | undefined = active ? { left: `${active.left}px`, top: `${active.top}px` } : undefined;

  const header = (
    <div className="panel-header">
      <div className="panel-title">
        <span className="panel-icon tone-warning" aria-hidden="true">
          {rhythm.mode === 'hour' ? <Clock className="h-4 w-4" /> : <CalendarDays className="h-4 w-4" />}
        </span>
        <span>{rhythm.mode === 'hour' ? '今日分时段节奏' : '星期消耗节奏'}</span>
        <InfoTip label="节奏口径说明">
          {rhythm.mode === 'hour'
            ? '仅今日范围有真实小时桶；当前小时标为进行中，未来小时不计入'
            : '仅以完整日按星期取日均；今天进行中与未来占位日均不计入'}
        </InfoTip>
      </div>
    </div>
  );

  if (rhythm.withheld) {
    // 观测不足（某个星期几少于 2 个完整日）：不画色阶，只说明原因（T10.159，审计 Q4）。
    return (
      <section className="panel usage-rhythm-panel" aria-label={rhythm.mode === 'hour' ? '今日分时段消耗节奏' : '按星期聚合的消耗节奏'}>
        {header}
        <div className="rhythm-foot">
          <div className="rhythm-summary" role="status">{rhythm.summary}</div>
        </div>
      </section>
    );
  }

  return (
    <section className="panel usage-rhythm-panel" aria-label={rhythm.mode === 'hour' ? '今日分时段消耗节奏' : '按星期聚合的消耗节奏'}>
      {header}

      <div className="rhythm-strip-wrap" ref={wrapRef} onMouseLeave={() => setActive(null)}>
        <div className={`rhythm-strip ${rhythm.mode === 'hour' ? 'is-hour' : 'is-weekday'}`}>
          {rhythm.cells.map((cell, index) => (
            <div
              key={cell.key}
              className={`rhythm-cell is-${cell.state}`}
              data-level={rhythmLevel(cell.state === 'future' ? 0 : cell.value, max)}
              role="img"
              aria-label={cell.title}
              aria-describedby={active?.index === index ? tooltipId : undefined}
              tabIndex={cell.state === 'future' ? -1 : 0}
              onMouseEnter={onEnter(index)}
              onFocus={onFocus(index)}
              onBlur={onBlur(index)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setActive(null);
              }}
            />
          ))}
        </div>
        {activeCell && (
          <div className="rhythm-tooltip-anchor" style={anchorStyle}>
            <RhythmTooltip cell={activeCell} id={tooltipId} mode={rhythm.mode} />
          </div>
        )}
      </div>
      <div className={`rhythm-axis ${rhythm.mode === 'hour' ? 'is-hour' : 'is-weekday'}`} aria-hidden="true">
        {rhythm.cells.map((cell) => (
          <span key={cell.key} className="rhythm-axis-label">{cell.label}</span>
        ))}
      </div>

      <div className="rhythm-foot">
        <div className="rhythm-summary" role="status">{rhythm.summary}</div>
        <div className="rhythm-legend" role="img" aria-label="色阶按本期峰值相对着色，越深消耗越多">
          <span>少</span>
          {[1, 2, 3, 4, 5].map((level) => <i key={level} data-level={level} />)}
          <span>多</span>
        </div>
      </div>
    </section>
  );
}

export const UsageRhythmPanel = memo(UsageRhythmPanelComponent);
export default UsageRhythmPanel;
