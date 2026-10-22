import type { BrandIconId } from './prototypeKit';

export type UsageRange = 'today' | 'week' | 'month' | 'last30';
export type UsageDimension = 'model' | 'tool' | 'project';
export type UsageMetric = 'tokens' | 'cost' | 'records';

export interface UsageEntity { id: string; label: string; icon?: BrandIconId; fallback?: string }

export const USAGE_MODELS: (UsageEntity & { price: { input: number; output: number; cacheRead: number; cacheWrite: number }; daily: number; cacheRatio: number; writeRatio: number })[] = [
  { id: 'gpt-5.5', label: 'gpt-5.5', icon: 'openai', price: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }, daily: 1_800_000, cacheRatio: 9, writeRatio: 0 },
  { id: 'claude-sonnet-5', label: 'claude-sonnet-5', icon: 'claude-color', price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, daily: 1_100_000, cacheRatio: 7, writeRatio: 0.3 },
  { id: 'gpt-5.5-mini', label: 'gpt-5.5-mini', icon: 'openai', price: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 }, daily: 500_000, cacheRatio: 5, writeRatio: 0 },
  { id: 'deepseek-v4', label: 'deepseek-v4', icon: 'deepseek-color', price: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 }, daily: 600_000, cacheRatio: 3, writeRatio: 0 },
  { id: 'gemini-3.1-pro', label: 'gemini-3.1-pro', icon: 'gemini-color', price: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 }, daily: 350_000, cacheRatio: 2, writeRatio: 0 },
  { id: 'kimi-k3', label: 'kimi-k3', icon: 'moonshot', price: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 }, daily: 150_000, cacheRatio: 1, writeRatio: 0 },
];

export const USAGE_TOOLS: UsageEntity[] = [
  { id: 'codex', label: 'Codex', icon: 'codex-color' },
  { id: 'claude-code', label: 'Claude Code', icon: 'claudecode-color' },
  { id: 'opencode', label: 'OpenCode', icon: 'opencode' },
  { id: 'gemini-cli', label: 'Gemini CLI', icon: 'geminicli-color' },
  { id: 'cursor', label: 'Cursor', icon: 'cursor' },
];

export const USAGE_PROJECTS: UsageEntity[] = [
  { id: 'tokenledger', label: 'TokenLedger', fallback: 'T' },
  { id: 'lighthouse', label: 'lighthouse', fallback: 'L' },
  { id: 'bang', label: 'bang', fallback: 'B' },
  { id: 'magpie-notes', label: 'magpie-notes', fallback: 'M' },
  { id: 'unattributed', label: '未归属', fallback: '—' },
];

const TOOL_SHARE: Record<string, Record<string, number>> = {
  'gpt-5.5': { codex: 0.85, opencode: 0.1, cursor: 0.05 },
  'claude-sonnet-5': { 'claude-code': 0.8, cursor: 0.15, opencode: 0.05 },
  'gpt-5.5-mini': { codex: 1 },
  'deepseek-v4': { opencode: 0.6, codex: 0.4 },
  'gemini-3.1-pro': { 'gemini-cli': 0.9, opencode: 0.1 },
  'kimi-k3': { opencode: 0.7, 'claude-code': 0.3 },
};
const PROJECT_SHARE: Record<string, number> = { tokenledger: 0.46, lighthouse: 0.2, bang: 0.14, 'magpie-notes': 0.08, unattributed: 0.12 };

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

interface Cell { input: number; output: number; cacheRead: number; cacheWrite: number; records: number; failed: number; cost: number }
const emptyCell = (): Cell => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, records: 0, failed: 0, cost: 0 });

function cellFor(modelIndex: number, effective: number, rand: () => number): Cell {
  const model = USAGE_MODELS[modelIndex];
  const input = Math.round(effective * (0.88 + rand() * 0.04));
  const output = Math.round(effective) - input;
  const cacheRead = Math.round(input * model.cacheRatio * (0.85 + rand() * 0.3));
  const cacheWrite = Math.round(input * model.writeRatio);
  const records = Math.max(effective > 0 ? 1 : 0, Math.round(effective / 16_000));
  const failed = model.id === 'kimi-k3' && rand() > 0.7 ? 1 : 0;
  const cost = (input * model.price.input + output * model.price.output + cacheRead * model.price.cacheRead + cacheWrite * model.price.cacheWrite) / 1_000_000;
  return { input, output, cacheRead, cacheWrite, records, failed, cost };
}

const DAYS = 30;
const END = new Date(2026, 9, 3);
const dayLabel = (offset: number) => {
  const date = new Date(END);
  date.setDate(END.getDate() - (DAYS - 1 - offset));
  return { label: `${date.getMonth() + 1}/${date.getDate()}`, weekday: (date.getDay() + 6) % 7, month: date.getMonth() };
};

const DAILY: Cell[][] = (() => {
  const rand = seeded(20261003);
  return Array.from({ length: DAYS }, (_, day) => {
    const { weekday } = dayLabel(day);
    const spike = day === 6 || day === 7 ? 2.6 : day === 24 ? 1.8 : 1;
    const factor = (weekday >= 5 ? 0.35 : 1) * spike * (0.6 + rand() * 0.8);
    return USAGE_MODELS.map((model, index) => cellFor(index, model.daily * factor * (0.5 + rand()), rand));
  });
})();

const HOURLY_SHAPE = [0.2, 0.1, 0, 0, 0, 0, 0, 0.1, 0.3, 0.8, 1, 0.9, 0.5, 0.7, 1, 1, 0.9, 0.8, 0.5, 0.4, 0.6, 0.9, 0.8, 0.5];
const TODAY_HOURS = 14;

export interface UsageSlice {
  labels: string[];
  cells: Cell[][];
  highlight: number | null;
  caption: string;
}

export function sliceFor(range: UsageRange): UsageSlice {
  if (range === 'today') {
    const today = DAILY[DAYS - 1];
    const weight = HOURLY_SHAPE.slice(0, TODAY_HOURS + 1).reduce((sum, value) => sum + value, 0);
    const cells = HOURLY_SHAPE.map((share, hour) => today.map((cell) => {
      if (hour > TODAY_HOURS) return emptyCell();
      const ratio = share / weight;
      return { input: Math.round(cell.input * ratio), output: Math.round(cell.output * ratio), cacheRead: Math.round(cell.cacheRead * ratio), cacheWrite: Math.round(cell.cacheWrite * ratio), records: Math.round(cell.records * ratio), failed: hour === 11 ? cell.failed : 0, cost: cell.cost * ratio };
    }));
    return { labels: HOURLY_SHAPE.map((_, hour) => `${hour}:00`), cells, highlight: TODAY_HOURS, caption: '今日 · 按小时' };
  }
  if (range === 'week') {
    const start = DAYS - 1 - dayLabel(DAYS - 1).weekday;
    return { labels: DAILY.slice(start).map((_, index) => dayLabel(start + index).label), cells: DAILY.slice(start), highlight: DAYS - 1 - start, caption: '本周 · 按日' };
  }
  if (range === 'month') {
    const start = DAILY.findIndex((_, index) => dayLabel(index).month === END.getMonth());
    return { labels: DAILY.slice(start).map((_, index) => dayLabel(start + index).label), cells: DAILY.slice(start), highlight: DAYS - 1 - start, caption: '本月 · 按日' };
  }
  return { labels: DAILY.map((_, index) => dayLabel(index).label), cells: DAILY, highlight: DAYS - 1, caption: '近 30 天 · 按日' };
}

export interface UsageTotals extends Cell { effective: number; cacheReuse: number | null; activeDays: number }

export function totalsOf(cells: Cell[][]): UsageTotals {
  const sum = emptyCell();
  let activeDays = 0;
  cells.forEach((column) => {
    let dayEffective = 0;
    column.forEach((cell) => {
      sum.input += cell.input; sum.output += cell.output; sum.cacheRead += cell.cacheRead; sum.cacheWrite += cell.cacheWrite;
      sum.records += cell.records; sum.failed += cell.failed; sum.cost += cell.cost;
      dayEffective += cell.input + cell.output;
    });
    if (dayEffective > 0) activeDays += 1;
  });
  const effective = sum.input + sum.output;
  const reuseBase = sum.input + sum.cacheRead;
  return { ...sum, effective, cacheReuse: reuseBase > 0 ? sum.cacheRead / reuseBase : null, activeDays };
}

export const metricOf = (cell: Cell, metric: UsageMetric) => (metric === 'tokens' ? cell.input + cell.output : metric === 'cost' ? cell.cost : cell.records);

const shareFor = (dimension: UsageDimension, modelId: string, entityId: string) => {
  if (dimension === 'model') return modelId === entityId ? 1 : 0;
  if (dimension === 'tool') return TOOL_SHARE[modelId]?.[entityId] ?? 0;
  return PROJECT_SHARE[entityId] ?? 0;
};

export const entitiesOf = (dimension: UsageDimension): UsageEntity[] => (dimension === 'model' ? USAGE_MODELS : dimension === 'tool' ? USAGE_TOOLS : USAGE_PROJECTS);

/** Column × entity values for one metric, split along a dimension. */
export function splitBy(cells: Cell[][], dimension: UsageDimension, metric: UsageMetric): number[][] {
  const entities = entitiesOf(dimension);
  return cells.map((column) => entities.map((entity) => column.reduce((sum, cell, modelIndex) => sum + metricOf(cell, metric) * shareFor(dimension, USAGE_MODELS[modelIndex].id, entity.id), 0)));
}

export interface EntityTotal extends UsageEntity { effective: number; input: number; output: number; cacheRead: number; cacheWrite: number; records: number; failed: number; cost: number; cacheReuse: number | null }

export function entityTotals(cells: Cell[][], dimension: UsageDimension): EntityTotal[] {
  return entitiesOf(dimension).map((entity) => {
    const sum = emptyCell();
    cells.forEach((column) => column.forEach((cell, modelIndex) => {
      const share = shareFor(dimension, USAGE_MODELS[modelIndex].id, entity.id);
      if (!share) return;
      sum.input += cell.input * share; sum.output += cell.output * share; sum.cacheRead += cell.cacheRead * share; sum.cacheWrite += cell.cacheWrite * share;
      sum.records += cell.records * share; sum.failed += Math.round(cell.failed * share); sum.cost += cell.cost * share;
    }));
    const reuseBase = sum.input + sum.cacheRead;
    return { ...entity, ...sum, effective: sum.input + sum.output, cacheReuse: reuseBase > 0 ? sum.cacheRead / reuseBase : null };
  }).filter((row) => row.effective > 0).sort((a, b) => b.effective - a.effective);
}

export function filterByTool(cells: Cell[][], toolId: string | null): Cell[][] {
  if (!toolId) return cells;
  return cells.map((column) => column.map((cell, modelIndex) => {
    const share = TOOL_SHARE[USAGE_MODELS[modelIndex].id]?.[toolId] ?? 0;
    return { input: Math.round(cell.input * share), output: Math.round(cell.output * share), cacheRead: Math.round(cell.cacheRead * share), cacheWrite: Math.round(cell.cacheWrite * share), records: Math.round(cell.records * share), failed: Math.round(cell.failed * share), cost: cell.cost * share };
  }));
}

export const HOUR_GRID: number[][] = (() => {
  const rand = seeded(7);
  return Array.from({ length: 7 }, (_, day) => HOURLY_SHAPE.map((share) => {
    const weekend = day >= 5 ? 0.3 : 1;
    const value = share * weekend * (0.4 + rand() * 1.2) * 240_000;
    return value < 20_000 ? 0 : Math.round(value);
  }));
})();

export type RecordSource = 'gateway' | 'log';

export interface UsageRecord {
  time: string;
  tool: string;
  model: string;
  modelIcon: BrandIconId;
  provider: string | null;
  route: string | null;
  project: string;
  source: RecordSource;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number | null;
  latencyMs: number | null;
  status: 'ok' | 'failed' | 'unknown';
  statusText?: string;
}

export const USAGE_RECORDS: UsageRecord[] = [
  { time: '10/3 14:21:08', tool: 'codex', model: 'gpt-5.5', modelIcon: 'openai', provider: 'OpenAI', route: 'group/coding', project: 'TokenLedger', source: 'gateway', input: 18_420, output: 1_204, cacheRead: 96_000, cacheWrite: 0, cost: 0.0471, latencyMs: 2_810, status: 'ok' },
  { time: '10/3 14:20:31', tool: 'codex', model: 'gpt-5.5', modelIcon: 'openai', provider: 'OpenAI', route: 'group/coding', project: 'TokenLedger', source: 'gateway', input: 2_310, output: 845, cacheRead: 101_376, cacheWrite: 0, cost: 0.0242, latencyMs: 1_940, status: 'ok' },
  { time: '10/3 14:18:02', tool: 'codex', model: 'deepseek-v4', modelIcon: 'deepseek-color', provider: 'DeepSeek', route: 'group/coding', project: 'TokenLedger', source: 'gateway', input: 9_870, output: 2_016, cacheRead: 0, cacheWrite: 0, cost: 0.0049, latencyMs: 3_420, status: 'ok' },
  { time: '10/3 14:17:55', tool: 'codex', model: 'kimi-k3', modelIcon: 'moonshot', provider: 'Kimi', route: 'group/coding', project: 'TokenLedger', source: 'gateway', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latencyMs: 210, status: 'failed', statusText: '401 · 已转 DeepSeek' },
  { time: '10/3 13:52:40', tool: 'claude-code', model: 'claude-sonnet-5', modelIcon: 'claude-color', provider: null, route: null, project: 'lighthouse', source: 'log', input: 31_200, output: 4_480, cacheRead: 212_000, cacheWrite: 9_400, cost: 0.2948, latencyMs: null, status: 'ok' },
  { time: '10/3 13:40:12', tool: 'opencode', model: 'deepseek-v4', modelIcon: 'deepseek-color', provider: 'DeepSeek', route: 'group/cheap', project: 'bang', source: 'gateway', input: 6_120, output: 1_880, cacheRead: 18_400, cacheWrite: 0, cost: 0.0050, latencyMs: 2_150, status: 'ok' },
  { time: '10/3 11:05:47', tool: 'gemini-cli', model: 'gemini-3.1-pro', modelIcon: 'gemini-color', provider: null, route: null, project: 'magpie-notes', source: 'log', input: 44_800, output: 3_960, cacheRead: 61_000, cacheWrite: 0, cost: 0.1493, latencyMs: null, status: 'ok' },
  { time: '10/3 10:44:19', tool: 'codex', model: 'gpt-5.5-mini', modelIcon: 'openai', provider: 'OpenAI', route: null, project: 'TokenLedger', source: 'gateway', input: 3_400, output: 620, cacheRead: 12_288, cacheWrite: 0, cost: 0.0024, latencyMs: 980, status: 'ok' },
  { time: '10/3 10:02:33', tool: 'cursor', model: 'claude-sonnet-5', modelIcon: 'claude-color', provider: null, route: null, project: '未归属', source: 'log', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null, latencyMs: null, status: 'unknown', statusText: '来源未给出用量' },
  { time: '10/3 09:31:06', tool: 'opencode', model: 'kimi-k3', modelIcon: 'moonshot', provider: 'Kimi', route: null, project: 'bang', source: 'gateway', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latencyMs: 188, status: 'failed', statusText: '401 · key 无效' },
];

export interface UsageSession {
  id: string;
  title: string;
  project: string;
  tool: string;
  model: string;
  effective: number;
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
  ago: string;
  messages: number;
  minutes: number;
}

export const USAGE_SESSIONS: UsageSession[] = [
  { id: 's1', title: '参考 magpie 重做模型与 Agent 工作区，并评估网关方案', project: 'TokenLedger', tool: 'codex', model: 'gpt-5.5', effective: 6_219_000, input: 5_890_000, output: 329_000, cacheRead: 98_400_000, cost: 22.61, ago: '3 小时前', messages: 148, minutes: 312 },
  { id: 's2', title: '安卓看板 390×844 截图回归失败排查', project: 'TokenLedger', tool: 'claude-code', model: 'claude-sonnet-5', effective: 4_467_000, input: 4_120_000, output: 347_000, cacheRead: 41_000_000, cost: 30.04, ago: '昨天', messages: 96, minutes: 205 },
  { id: 's3', title: '对比 0.9 与 0.10 的改动并做全局评审', project: 'lighthouse', tool: 'codex', model: 'gpt-5.5', effective: 3_159_000, input: 2_980_000, output: 179_000, cacheRead: 52_000_000, cost: 12.02, ago: '2 天前', messages: 61, minutes: 140 },
  { id: 's4', title: '复盘：为什么一个简单任务做了 8 个小时', project: 'TokenLedger', tool: 'codex', model: 'gpt-5.5-mini', effective: 2_406_000, input: 2_250_000, output: 156_000, cacheRead: 18_000_000, cost: 1.32, ago: '3 天前', messages: 44, minutes: 96 },
  { id: 's5', title: '整理 lighthouse 情报推送流程', project: 'lighthouse', tool: 'opencode', model: 'deepseek-v4', effective: 1_822_000, input: 1_640_000, output: 182_000, cacheRead: 5_200_000, cost: 0.81, ago: '4 天前', messages: 37, minutes: 58 },
  { id: 's6', title: '（无提示词）', project: 'bang', tool: 'gemini-cli', model: 'gemini-3.1-pro', effective: 1_586_000, input: 1_470_000, output: 116_000, cacheRead: 2_900_000, cost: 4.91, ago: '5 天前', messages: 12, minutes: 21 },
];

export const SESSION_SHAPE = [
  { label: '1–5', value: 56 },
  { label: '6–15', value: 38 },
  { label: '16–30', value: 9 },
  { label: '31–60', value: 10 },
  { label: '61–120', value: 3 },
  { label: '121+', value: 4 },
];

export const FUNCTION_CALLS = [
  { id: 'exec', label: 'exec / Bash', value: 7_306, meta: '106 个会话' },
  { id: 'read', label: '读文件', value: 1_204, meta: '88 个会话' },
  { id: 'edit', label: '改文件', value: 812, meta: '71 个会话' },
  { id: 'search', label: '搜索', value: 405, meta: '39 个会话' },
  { id: 'web', label: '联网', value: 162, meta: '18 个会话' },
  { id: 'agent', label: '子 Agent', value: 104, meta: '9 个会话' },
  { id: 'mcp', label: 'MCP', value: 66, meta: '5 个会话' },
];
