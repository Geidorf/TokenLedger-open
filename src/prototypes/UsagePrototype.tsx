import { useMemo, useState } from 'react';
import { ArrowDownToLine, ChevronDown, Info, RefreshCw, Search } from 'lucide-react';
import { formatEstimatedUsd, formatNum, formatTokens } from '../utils/format';
import { BrandIcon, CHART_COLORS, HourHeatmap, RankList, Seg, StackedBars } from './prototypeKit';
import {
  FUNCTION_CALLS,
  HOUR_GRID,
  SESSION_SHAPE,
  USAGE_MODELS,
  USAGE_RECORDS,
  USAGE_SESSIONS,
  USAGE_TOOLS,
  entitiesOf,
  entityTotals,
  filterByTool,
  metricOf,
  sliceFor,
  splitBy,
  totalsOf,
  type RecordSource,
  type UsageDimension,
  type UsageMetric,
  type UsageRange,
} from './usageFixtures';

export type UsageSub = 'overview' | 'records' | 'sessions';

const RANGE_OPTIONS: { id: UsageRange; label: string }[] = [
  { id: 'today', label: '今日' },
  { id: 'week', label: '本周' },
  { id: 'month', label: '本月' },
  { id: 'last30', label: '近 30 天' },
];
const METRIC_OPTIONS: { id: UsageMetric; label: string }[] = [
  { id: 'tokens', label: '有效 Token' },
  { id: 'cost', label: '预估费用' },
  { id: 'records', label: '记录数' },
];
const DIMENSION_LABEL: Record<UsageDimension, string> = { model: '模型', tool: '工具', project: '项目' };

const percent = (value: number | null) => (value === null ? '不可得' : `${(value * 100).toFixed(1)}%`);
const formatMetric = (metric: UsageMetric) => (value: number) => (metric === 'tokens' ? formatTokens(value) : metric === 'cost' ? formatEstimatedUsd(value).replace('≈', '') : formatNum(value));
const toolOf = (id: string) => USAGE_TOOLS.find((tool) => tool.id === id);

function Kpi({ label, value, sub, tone, bar }: { label: string; value: string; sub: string; tone?: 'cost'; bar?: number | null }) {
  return (
    <div className="mw-kpi-cell">
      <span className="mw-kpi-label">{label}</span>
      <strong className={tone === 'cost' ? 'is-cost' : ''}>{value}</strong>
      {bar !== undefined && <span className="mw-kpi-bar"><span style={{ width: `${(bar ?? 0) * 100}%` }} /></span>}
      <small>{sub}</small>
    </div>
  );
}

function ToolChips({ value, onChange }: { value: string | null; onChange: (value: string | null) => void }) {
  return (
    <div className="mw-chips" role="radiogroup" aria-label="按工具筛选">
      <button type="button" role="radio" aria-checked={value === null} className={value === null ? 'is-on' : ''} onClick={() => onChange(null)}>全部工具</button>
      {USAGE_TOOLS.map((tool) => (
        <button key={tool.id} type="button" role="radio" aria-checked={value === tool.id} className={value === tool.id ? 'is-on' : ''} onClick={() => onChange(tool.id)}>
          <BrandIcon id={tool.icon} size={14} />{tool.label}
        </button>
      ))}
    </div>
  );
}

function FakeSelect({ label }: { label: string }) {
  return <button type="button" className="mw-select">{label}<ChevronDown className="h-3.5 w-3.5" /></button>;
}

function Overview({ range, tool }: { range: UsageRange; tool: string | null }) {
  const [metric, setMetric] = useState<UsageMetric>('tokens');
  const [dimension, setDimension] = useState<UsageDimension>('model');
  const activeDimension = tool && dimension === 'tool' ? 'model' : dimension;
  const slice = useMemo(() => sliceFor(range), [range]);
  const cells = useMemo(() => filterByTool(slice.cells, tool), [slice, tool]);
  const totals = useMemo(() => totalsOf(cells), [cells]);
  const entities = entitiesOf(activeDimension);
  const values = useMemo(() => splitBy(cells, activeDimension, metric), [cells, activeDimension, metric]);
  const ranked = useMemo(() => entityTotals(cells, activeDimension), [cells, activeDimension]);
  const tools = useMemo(() => entityTotals(slice.cells, 'tool'), [slice]);
  const series = entities.map((entity, index) => ({ id: entity.id, label: entity.label, color: CHART_COLORS[index % CHART_COLORS.length] }));
  const colorOf = (id: string) => series.find((item) => item.id === id)?.color;
  const fmt = formatMetric(metric);
  const lead = ranked[0];
  const leadShare = lead ? lead.effective / Math.max(1, totals.effective) : 0;
  const rangeLabel = RANGE_OPTIONS.find((option) => option.id === range)?.label;

  return (
    <div className="mw-usage-body">
      <p className="mw-conclusion">
        {rangeLabel}有效 Token <b>{formatTokens(totals.effective)}</b>，比上期同期 <b className="is-up">+18.4%</b>；
        {lead && <> {lead.label} 占 <b>{(leadShare * 100).toFixed(0)}%</b>；</>}
        缓存复用率 <b>{percent(totals.cacheReuse)}</b>。
      </p>
      <div className="mw-card mw-kpi-strip">
        <Kpi label="有效 Token" value={formatTokens(totals.effective)} sub={`输入 ${formatTokens(totals.input)} · 输出 ${formatTokens(totals.output)}`} />
        <Kpi label="预估费用" value={formatEstimatedUsd(totals.cost)} sub="按价格表估算 · 2 条待核价" tone="cost" />
        <Kpi label="缓存复用率" value={percent(totals.cacheReuse)} bar={totals.cacheReuse} sub={`读 ${formatTokens(totals.cacheRead)} · 写 ${formatTokens(totals.cacheWrite)}，不计入有效 Token`} />
        <Kpi label="记录数" value={formatNum(totals.records)} sub={`活跃 ${totals.activeDays} ${range === 'today' ? '小时' : '天'} · 网关失败 ${totals.failed} 次`} />
      </div>
      <div className="mw-card mw-chart-card">
        <div className="mw-chart-head">
          <Seg value={metric} options={METRIC_OPTIONS} onChange={setMetric} label="图表指标" size="sm" />
          <div className="mw-chart-split">
            <span>拆分</span>
            <Seg
              value={activeDimension}
              options={(['model', 'tool', 'project'] as const).filter((id) => !(tool && id === 'tool')).map((id) => ({ id, label: DIMENSION_LABEL[id] }))}
              onChange={setDimension}
              label="拆分维度"
              size="sm"
            />
          </div>
        </div>
        <div className="mw-chart-body">
          <StackedBars labels={slice.labels} series={series} values={values} format={fmt} highlight={slice.highlight} height={230} />
          <div className="mw-chart-legend tl-scrollbar">
            <RankList
              limit={8}
              format={(value) => fmt(value)}
              rows={ranked.map((row) => ({
                id: row.id,
                label: row.label,
                value: metric === 'tokens' ? row.effective : metric === 'cost' ? row.cost : row.records,
                color: colorOf(row.id),
                meta: `${formatNum(row.records)} 条 · ${formatEstimatedUsd(row.cost)} · 复用率 ${percent(row.cacheReuse)} · 占 ${((row.effective / Math.max(1, totals.effective)) * 100).toFixed(0)}%`,
                danger: row.failed > 0 ? `${row.failed} 次失败` : undefined,
              }))}
            />
          </div>
        </div>
      </div>
      <p className="mw-sumline">
        {formatNum(totals.records)} 条记录 · 输入 {formatTokens(totals.input)} · 输出 {formatTokens(totals.output)} · 缓存写入 {formatTokens(totals.cacheWrite)} · 缓存读取 {formatTokens(totals.cacheRead)} · 网关失败 {totals.failed} 次
      </p>
      <div className="mw-two-col">
        <div className="mw-card mw-panel">
          <div className="mw-panel-head"><h3>工具</h3><span>有效 Token · 点击进入专属看板</span></div>
          <RankList
            format={formatTokens}
            rows={tools.map((row) => ({
              id: row.id,
              label: row.label,
              value: row.effective,
              icon: <BrandIcon id={toolOf(row.id)?.icon} size={18} />,
              trailing: formatEstimatedUsd(row.cost),
              meta: `${formatNum(row.records)} 条 · 复用率 ${percent(row.cacheReuse)}`,
            }))}
          />
        </div>
        <div className="mw-card mw-panel">
          <div className="mw-panel-head"><h3>时段</h3><span>Asia/Shanghai · 有效 Token</span></div>
          <HourHeatmap grid={HOUR_GRID} caption="最忙：周二 15:00" />
        </div>
      </div>
    </div>
  );
}

function Records({ tool }: { tool: string | null }) {
  const [source, setSource] = useState<'all' | RecordSource>('all');
  const [onlyFailed, setOnlyFailed] = useState(false);
  const rows = USAGE_RECORDS.filter((row) => (!tool || row.tool === tool) && (source === 'all' || row.source === source) && (!onlyFailed || row.status === 'failed'));
  const sum = rows.reduce((acc, row) => ({ input: acc.input + row.input, output: acc.output + row.output, cacheRead: acc.cacheRead + row.cacheRead, cacheWrite: acc.cacheWrite + row.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  return (
    <div className="mw-usage-body">
      <div className="mw-filter-row">
        <Seg value={source} options={[{ id: 'all', label: '全部来源' }, { id: 'gateway', label: '网关' }, { id: 'log', label: '日志扫描' }]} onChange={setSource} label="来源" size="sm" />
        <Seg value={onlyFailed ? 'failed' : 'all'} options={[{ id: 'all', label: '全部' }, { id: 'failed', label: '失败' }]} onChange={(value) => setOnlyFailed(value === 'failed')} label="状态" size="sm" />
        <span className="mw-flex" />
        <label className="mw-search is-inline"><Search className="h-4 w-4" aria-hidden="true" /><input placeholder="搜索模型、项目、会话" aria-label="搜索记录" /></label>
        <button type="button" className="mw-btn is-ghost"><ArrowDownToLine className="h-3.5 w-3.5" />导出 CSV</button>
      </div>
      <p className="mw-sumline">
        {rows.length} 条记录 · 有效 Token {formatTokens(sum.input + sum.output)}（输入 {formatTokens(sum.input)} · 输出 {formatTokens(sum.output)}）· 缓存读 {formatTokens(sum.cacheRead)} · 缓存写 {formatTokens(sum.cacheWrite)}
        <span className="mw-sumline-note"><Info className="h-3.5 w-3.5" />网关记录与日志扫描到的同一请求只计一次（去重规则待契约确定）</span>
      </p>
      <div className="mw-card mw-table-wrap tl-scrollbar">
        <table className="mw-table is-records">
          <thead>
            <tr><th>时间</th><th>工具</th><th>模型</th><th>供应商 · 路由</th><th>项目</th><th>来源</th><th className="is-num">输入</th><th className="is-num">输出</th><th className="is-num">缓存读</th><th className="is-num">缓存写</th><th className="is-num">预估费用</th><th className="is-num">耗时</th><th>状态</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const toolMeta = toolOf(row.tool);
              const unknown = row.status === 'unknown';
              return (
                <tr key={`${row.time}-${row.model}`}>
                  <td className="is-time">{row.time}</td>
                  <td><span className="mw-cell-icon"><BrandIcon id={toolMeta?.icon} size={15} />{toolMeta?.label}</span></td>
                  <td><span className="mw-cell-icon"><BrandIcon id={row.modelIcon} size={15} />{row.model}</span></td>
                  <td>{row.provider ? <span className="mw-cell-stack"><span>{row.provider}</span>{row.route && <small>{row.route}</small>}</span> : <span className="mw-faint">—</span>}</td>
                  <td>{row.project}</td>
                  <td><span className={`mw-chip ${row.source === 'gateway' ? 'is-info' : ''}`}>{row.source === 'gateway' ? '网关' : '日志'}</span></td>
                  <td className="is-num">{unknown ? '—' : formatNum(row.input)}</td>
                  <td className="is-num">{unknown ? '—' : formatNum(row.output)}</td>
                  <td className="is-num">{unknown ? '—' : formatNum(row.cacheRead)}</td>
                  <td className="is-num">{unknown ? '—' : formatNum(row.cacheWrite)}</td>
                  <td className={`is-num ${row.cost === null ? 'mw-faint' : 'is-cost'}`}>{formatEstimatedUsd(row.cost, 'record')}</td>
                  <td className="is-num">{row.latencyMs === null ? '—' : `${(row.latencyMs / 1000).toFixed(1)} 秒`}</td>
                  <td>
                    {row.status === 'ok' && <span className="mw-chip is-success">成功</span>}
                    {row.status === 'failed' && <span className="mw-chip is-danger" title={row.statusText}>{row.statusText?.split(' · ')[0]}</span>}
                    {row.status === 'unknown' && <span className="mw-chip" title={row.statusText}>无用量</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Sessions({ range, tool }: { range: UsageRange; tool: string | null }) {
  const [metric, setMetric] = useState<UsageMetric>('tokens');
  const [sessionSort, setSessionSort] = useState<'tokens' | 'cost' | 'minutes'>('tokens');
  const slice = useMemo(() => sliceFor(range), [range]);
  const cells = useMemo(() => filterByTool(slice.cells, tool), [slice, tool]);
  const totals = useMemo(() => totalsOf(cells), [cells]);
  const projects = useMemo(() => entityTotals(cells, 'project'), [cells]);
  const models = useMemo(() => entityTotals(cells, 'model'), [cells]);
  const trend = cells.map((column) => [column.reduce((sum, cell) => sum + metricOf(cell, metric), 0)]);
  const sessionCount = Math.max(1, Math.round(totals.records / 38));
  const sessions = USAGE_SESSIONS.filter((session) => !tool || session.tool === tool)
    .sort((a, b) => (sessionSort === 'cost' ? b.cost - a.cost : sessionSort === 'minutes' ? b.minutes - a.minutes : b.effective - a.effective));
  const shapeMax = Math.max(...SESSION_SHAPE.map((bucket) => bucket.value));
  const modelIcon = (id: string) => USAGE_MODELS.find((model) => model.id === id)?.icon;

  return (
    <div className="mw-usage-body">
      <div className="mw-card mw-kpi-strip is-six">
        <Kpi label="会话数" value={formatNum(sessionCount)} sub="缺会话 ID 的记录不计入" />
        <Kpi label="有效 Token" value={formatTokens(totals.effective)} sub={`每会话中位 ${formatTokens(totals.effective / sessionCount / 1.6)}`} />
        <Kpi label="预估费用" value={formatEstimatedUsd(totals.cost)} sub="按价格表估算" tone="cost" />
        <Kpi label="缓存复用率" value={percent(totals.cacheReuse)} bar={totals.cacheReuse} sub={`缓存读 ${formatTokens(totals.cacheRead)}`} />
        <Kpi label="活跃时长" value={range === 'today' ? '5 小时 12 分' : '58 小时 20 分'} sub={`共 ${totals.activeDays} ${range === 'today' ? '小时' : '天'}有用量`} />
        <Kpi label="项目" value={String(projects.filter((row) => row.id !== 'unattributed').length)} sub={`${projects[0]?.label ?? '—'} 占 ${projects[0] ? ((projects[0].effective / Math.max(1, totals.effective)) * 100).toFixed(0) : 0}%`} />
      </div>
      <div className="mw-card mw-chart-card">
        <div className="mw-chart-head">
          <h3 className="mw-chart-title">每日趋势</h3>
          <Seg value={metric} options={METRIC_OPTIONS} onChange={setMetric} label="趋势指标" size="sm" />
        </div>
        <StackedBars labels={slice.labels} series={[{ id: 'all', label: '合计', color: 'var(--chart-2)' }]} values={trend} format={formatMetric(metric)} highlight={slice.highlight} height={150} />
      </div>
      <div className="mw-two-col">
        <div className="mw-card mw-panel">
          <div className="mw-panel-head"><h3>项目</h3><span>有效 Token</span></div>
          <RankList dense format={formatTokens} rows={projects.map((row) => ({ id: row.id, label: row.label, value: row.effective, color: 'var(--chart-2)', trailing: formatEstimatedUsd(row.cost) }))} />
        </div>
        <div className="mw-card mw-panel">
          <div className="mw-panel-head"><h3>模型</h3><span>有效 Token</span></div>
          <RankList dense format={formatTokens} rows={models.map((row) => ({ id: row.id, label: row.label, value: row.effective, icon: <BrandIcon id={modelIcon(row.id)} size={16} />, color: 'var(--chart-1)', trailing: formatEstimatedUsd(row.cost) }))} />
        </div>
      </div>
      <div className="mw-two-col">
        <div className="mw-card mw-panel">
          <div className="mw-panel-head"><h3>最耗会话</h3><Seg value={sessionSort} options={[{ id: 'tokens', label: 'Token' }, { id: 'cost', label: '费用' }, { id: 'minutes', label: '时长' }]} onChange={setSessionSort} label="会话排序" size="sm" /></div>
          <ul className="mw-session-list">
            {sessions.map((session) => (
              <li key={session.id}>
                <BrandIcon id={toolOf(session.tool)?.icon} size={22} />
                <div>
                  <strong>{session.title}</strong>
                  <span>{session.project} · {toolOf(session.tool)?.label} · {session.model} · {session.ago} · {session.messages} 条消息</span>
                </div>
                <span className="mw-session-value">
                  {sessionSort === 'cost' ? formatEstimatedUsd(session.cost) : sessionSort === 'minutes' ? `${Math.floor(session.minutes / 60)} 小时 ${session.minutes % 60} 分` : formatTokens(session.effective)}
                  <small>缓存读 {formatTokens(session.cacheRead)}</small>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="mw-card mw-panel">
          <div className="mw-panel-head"><h3>时段</h3><span>Asia/Shanghai</span></div>
          <HourHeatmap grid={HOUR_GRID} caption="最忙：周二 15:00" />
          <div className="mw-panel-head is-sub"><h3>会话形态</h3><span>横轴：一个会话的消息数 · 柱高：会话数</span></div>
          <div className="mw-shape">
            {SESSION_SHAPE.map((bucket) => (
              <div key={bucket.label} className="mw-shape-col">
                <span className="mw-shape-n">{bucket.value}</span>
                <span className="mw-shape-bar" style={{ height: `${(bucket.value / shapeMax) * 100}%` }} />
                <span className="mw-shape-x">{bucket.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mw-card mw-panel">
        <div className="mw-panel-head"><h3>函数调用</h3><span>Agent 在会话里调用的命令、读写文件、搜索等 · 9,245 次 · 107 个会话</span></div>
        <RankList dense columns limit={8} format={formatNum} rows={FUNCTION_CALLS.map((row) => ({ ...row, color: 'var(--chart-3)' }))} />
      </div>
    </div>
  );
}

export function UsageView({ initialSub }: { initialSub: UsageSub }) {
  const [sub, setSub] = useState<UsageSub>(initialSub);
  const [range, setRange] = useState<UsageRange>('last30');
  const [tool, setTool] = useState<string | null>(null);
  const totals = useMemo(() => totalsOf(filterByTool(sliceFor(range).cells, tool)), [range, tool]);
  return (
    <div className="mw-usage">
      <div className="mw-usage-bar">
        <Seg value={sub} options={[{ id: 'overview', label: '概览' }, { id: 'records', label: '记录' }, { id: 'sessions', label: '会话' }]} onChange={setSub} label="用量视图" />
        <Seg value={range} options={RANGE_OPTIONS} onChange={setRange} label="时间范围" />
        <span className="mw-flex" />
        <span className="mw-refresh"><RefreshCw className="h-3.5 w-3.5" />14:21 已扫描 · 每 5 分钟</span>
        <span className="mw-usage-cost"><b>{formatEstimatedUsd(totals.cost)}</b> 预估费用</span>
      </div>
      <div className="mw-filter-row">
        <ToolChips value={tool} onChange={setTool} />
        <FakeSelect label="全部模型" />
        <FakeSelect label="全部项目" />
      </div>
      {sub === 'overview' && <Overview range={range} tool={tool} />}
      {sub === 'records' && <Records tool={tool} />}
      {sub === 'sessions' && <Sessions range={range} tool={tool} />}
    </div>
  );
}
