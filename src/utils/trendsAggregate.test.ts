import { describe, expect, it } from 'vitest';
import {
  isDrillableDateBucket,
  trendBucketKind,
  trendBucketTokens,
  weekdayOfDateBucket,
} from './trendsAggregate';

describe('trendBucketTokens', () => {
  it('sums per-tool keys and ignores date, reserved metadata, and non-finite values', () => {
    const point = {
      date: '2026-08-30',
      codex: 120,
      claude: 30.5,
      __requests: 40,
      __futureMetadata: 9_000,
      other: Number.NaN,
    } as any;
    expect(trendBucketTokens(point)).toBe(150.5);
  });

  it('never treats cloud __requests as token consumption', () => {
    expect(trendBucketTokens({ date: '2026-08-30', codex: 100, __requests: 40 } as any)).toBe(100);
    expect(trendBucketTokens({ date: '2026-08-30', __requests: 40 } as any)).toBe(0);
  });

  it('returns 0 for nullish or key-less points instead of reading a phantom totalTokens', () => {
    expect(trendBucketTokens(null)).toBe(0);
    expect(trendBucketTokens(undefined)).toBe(0);
    expect(trendBucketTokens({ date: '2026-08-30' } as any)).toBe(0);
    // Contract points are keyed by tool name; a bucket with no tool data must
    // aggregate to 0 — there is no totalTokens/tokens fallback field (the old
    // panel code silently read one and always saw 0).
    expect(trendBucketTokens({ date: '09:00' } as any)).toBe(0);
  });

  it('sums ordinary per-tool keys without relying on a totalTokens alias', () => {
    const point = { date: '09:00', codex: 10, claude: 20, minimax: 5 } as any;
    expect(trendBucketTokens(point)).toBe(35);
  });
});

describe('trendBucketKind', () => {
  it('recognizes the per-range bucket formats emitted by the Rust aggregator', () => {
    expect(trendBucketKind('09:00')).toBe('hour');
    expect(trendBucketKind('2026-08-30')).toBe('day');
    expect(trendBucketKind('3月')).toBe('month');
    expect(trendBucketKind('3M')).toBe('month');
    expect(trendBucketKind('12月')).toBe('month');
    expect(trendBucketKind('2026-03')).toBe('month');
  });

  it('returns null for unknown formats rather than guessing', () => {
    expect(trendBucketKind('')).toBeNull();
    expect(trendBucketKind(null)).toBeNull();
    expect(trendBucketKind('2026/08/30')).toBeNull();
    expect(trendBucketKind('2026-8-3')).toBeNull();
    expect(trendBucketKind('9:00')).toBeNull();
    expect(trendBucketKind('24:00')).toBeNull();
    expect(trendBucketKind('09:30')).toBeNull();
    expect(trendBucketKind('13月')).toBeNull();
    expect(trendBucketKind('2026-13')).toBeNull();
    expect(trendBucketKind('2026-02-30')).toBeNull();
  });
});

describe('weekdayOfDateBucket', () => {
  it('parses civil date buckets deterministically regardless of host timezone', () => {
    // 2026-08-30 is a Sunday.
    expect(weekdayOfDateBucket('2026-08-30')).toBe(0);
    // 2026-08-31 is a Monday.
    expect(weekdayOfDateBucket('2026-08-31')).toBe(1);
  });

  it('rejects non-day buckets and impossible dates', () => {
    expect(weekdayOfDateBucket('09:00')).toBeNull();
    expect(weekdayOfDateBucket('3月')).toBeNull();
    expect(weekdayOfDateBucket('2026-02-30')).toBeNull();
  });
});

describe('isDrillableDateBucket', () => {
  it('only full day buckets may be forwarded to detail drill-down', () => {
    expect(isDrillableDateBucket('2026-08-30')).toBe(true);
    expect(isDrillableDateBucket('09:00')).toBe(false);
    expect(isDrillableDateBucket('3月')).toBe(false);
  });
});
