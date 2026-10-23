import { describe, expect, it, vi } from 'vitest';
import type { LogHistoryItem, UsageDetailsResponse } from '../types';
import { collectAllDetails, REQUESTS_CSV_COLUMNS, requestCsvRow, requestsToCsv } from './requestsCsv';

function item(overrides: Partial<LogHistoryItem> = {}): LogHistoryItem {
  return {
    id: 1,
    tool: 'codex',
    model: 'gpt-5-codex',
    inputTokens: 300,
    outputTokens: 50,
    cachedTokens: 120,
    cacheReadTokens: 100,
    cacheWriteTokens: 20,
    cost: 0.25,
    timestamp: '2026-07-15T14:05:00+08:00',
    sessionId: 'sess-1',
    machineId: 'Studio-PC',
    usageProvenance: 'reported',
    ...overrides,
  };
}

function page(items: LogHistoryItem[], nextCursor: string | null): UsageDetailsResponse {
  return {
    items,
    nextCursor,
    hasMore: nextCursor !== null,
    totalCount: 0,
    filteredSummary: {} as UsageDetailsResponse['filteredSummary'],
    availableFilters: { tools: [], models: [], machines: [] },
    granularity: 'request',
  };
}

describe('requestsToCsv', () => {
  it('writes the fixed header and one line per row', () => {
    const csv = requestsToCsv([item(), item({ id: 2 })]);
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe(REQUESTS_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(3);
  });

  it('splits cache read/write and computes the hit rate only when the split is proven', () => {
    const cells = requestCsvRow(item()).split(',');
    const at = (column: (typeof REQUESTS_CSV_COLUMNS)[number]) => cells[REQUESTS_CSV_COLUMNS.indexOf(column)];
    expect(at('cache_read_tokens')).toBe('100');
    expect(at('cache_write_tokens')).toBe('20');
    expect(at('cache_hit_rate')).toBe('0.25');

    const combined = requestCsvRow(item({ cacheReadTokens: undefined, cacheWriteTokens: undefined })).split(',');
    expect(combined[REQUESTS_CSV_COLUMNS.indexOf('cache_read_tokens')]).toBe('');
    expect(combined[REQUESTS_CSV_COLUMNS.indexOf('cache_hit_rate')]).toBe('');
    expect(combined[REQUESTS_CSV_COLUMNS.indexOf('cached_tokens')]).toBe('120');
  });

  it('quotes separators and neutralises spreadsheet formulas', () => {
    const row = requestCsvRow(item({ model: 'a,"b"', sessionId: '=HYPERLINK("x")' }));
    expect(row).toContain('"a,""b"""');
    expect(row).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('collectAllDetails', () => {
  it('follows the cursor until the last page', async () => {
    const fetchPage = vi.fn(async (cursor: string | null) => (
      cursor === null ? page([item({ id: 1 })], 'c1') : page([item({ id: 2 })], null)
    ));
    const result = await collectAllDetails(fetchPage);
    expect(result.items.map((row) => row.id)).toEqual([1, 2]);
    expect(result.truncated).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('stops at the row cap and reports truncation', async () => {
    let n = 0;
    const result = await collectAllDetails(async () => page([item({ id: ++n }), item({ id: ++n })], `c${n}`), 3);
    expect(result.items).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('stops when the backend repeats a cursor instead of looping', async () => {
    const fetchPage = vi.fn(async () => page([item()], 'same'));
    const result = await collectAllDetails(fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.truncated).toBe(false);
  });
});
