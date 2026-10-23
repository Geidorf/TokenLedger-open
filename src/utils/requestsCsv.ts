import type { DataScope, LogHistoryItem, UsageDetailsResponse } from '../types';
import { isEstimatedLogItem } from '../types';
import { resolveCacheBreakdown } from './cacheDisplay';
import { cacheHitRate } from './usageSplit';

/**
 * 用量 · 请求的「导出 CSV」：导出当前范围与筛选下的全部行，
 * 不只是已加载的那一页。列与界面同一口径：缓存读写只在拆分可证明时分列，否则只给合计；
 * 缺失的值写空，不写 0。
 */
export const REQUESTS_CSV_COLUMNS = [
  'time',
  'tool',
  'model',
  'provider',
  'source',
  'granularity',
  'requests',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cached_tokens',
  'cache_hit_rate',
  'cost_usd',
  'usage_estimated',
  'session_id',
  'machine_id',
] as const;

/** 一次导出最多取的行数；超过时只导出前这么多行并告知，避免把界面卡死。 */
export const REQUESTS_CSV_MAX_ROWS = 50_000;

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  // 表格软件会把 = + - @ 开头的文本当公式执行，加单引号让它保持文本。
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * `source`：本机明细缺省即扫描（契约 §2.5）；云端小时聚合可能混有网关与扫描记录且不带来源，留空不猜。
 * `usage_estimated`：Token 用量是否为约数（来源日志未给精确用量），不是费用是否按价格表估算。
 */
export function requestCsvRow(item: LogHistoryItem, scope: DataScope = 'local'): string {
  const cache = resolveCacheBreakdown(item);
  const read = cache.kind === 'split' ? cache.read : null;
  const hit = read === null ? null : cacheHitRate(item.inputTokens, read);
  const cells: (string | number | null | undefined)[] = [
    item.timestamp,
    item.tool,
    item.model,
    item.provider,
    item.source ?? (scope === 'local' ? 'scan' : null),
    item.granularity ?? 'request',
    item.requests || 1,
    item.inputTokens,
    item.outputTokens,
    read,
    cache.kind === 'split' ? cache.write : null,
    item.cachedTokens,
    hit === null ? null : Number(hit.toFixed(4)),
    item.cost,
    isEstimatedLogItem(item) ? 'true' : 'false',
    item.sessionId,
    item.machineId,
  ];
  return cells.map(csvCell).join(',');
}

export function requestsToCsv(items: LogHistoryItem[], scope: DataScope = 'local'): string {
  return [REQUESTS_CSV_COLUMNS.join(','), ...items.map((item) => requestCsvRow(item, scope))].join('\n') + '\n';
}

export interface CollectedDetails {
  items: LogHistoryItem[];
  /** 达到行数上限而停止；true 时导出的只是前 `REQUESTS_CSV_MAX_ROWS` 行。 */
  truncated: boolean;
}

/** 沿游标逐页取完当前筛选下的明细。`fetchPage` 抛错时整个导出失败，不写半份文件。 */
export async function collectAllDetails(
  fetchPage: (cursor: string | null) => Promise<UsageDetailsResponse>,
  maxRows = REQUESTS_CSV_MAX_ROWS,
): Promise<CollectedDetails> {
  const items: LogHistoryItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    if (items.length >= maxRows) {
      return { items: items.slice(0, maxRows), truncated: items.length > maxRows || page.hasMore };
    }
    const next = page.nextCursor ?? null;
    // 游标不前进时停下，防止后端异常把导出变成死循环。
    if (!page.hasMore || !next || seenCursors.has(next)) return { items, truncated: false };
    seenCursors.add(next);
    cursor = next;
  }
}
