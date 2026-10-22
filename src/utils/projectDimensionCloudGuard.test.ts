import { describe, expect, it } from 'vitest';
import type { StatsData } from '../types';
import type { ShareCardOptions } from './shareCardRenderer';
import type { VisualDigestOptions } from './reportExport';
import type { BuildShareSummaryOptions } from './shareSummary';

type ProjectLeak<T> = Extract<keyof T, 'projectDimension' | 'projects' | 'unattributed' | 'local_session_projects'>;

function assertNoProjectKeys<T>(value: ProjectLeak<T> extends never ? true : never) {
  expect(value).toBe(true);
}

describe('项目字段不进入分享、简报和 Stats v2', () => {
  it('这些类型的键里没有项目维度', () => {
    assertNoProjectKeys<StatsData>(true);
    assertNoProjectKeys<BuildShareSummaryOptions>(true);
    assertNoProjectKeys<VisualDigestOptions>(true);
    assertNoProjectKeys<ShareCardOptions>(true);
  });
});
