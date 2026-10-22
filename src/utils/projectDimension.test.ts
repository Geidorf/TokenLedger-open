import { describe, expect, it } from 'vitest';
import {
  parseProjectDimensionStatus,
  projectAliasMap,
  projectDisplayName,
  projectFailureCopy,
} from './projectDimension';

const disabled = {
  enabled: false,
  state: 'disabled',
  consentVersion: 0,
  requiredConsentVersion: 1,
  gitProbeEnabled: false,
  backfill: { status: 'idle', done: 0, total: 0 },
  indexedSessions: 0,
  namedProjects: 0,
  unresolvedSessions: 0,
  lastFailure: null,
};

describe('parseProjectDimensionStatus', () => {
  it('接受关闭态，缺字段或未知状态则拒绝', () => {
    expect(parseProjectDimensionStatus(disabled)?.enabled).toBe(false);
    expect(parseProjectDimensionStatus({ ...disabled, state: 'paused' })).toBeNull();
    expect(parseProjectDimensionStatus({ ...disabled, enabled: 'yes' })).toBeNull();
    expect(parseProjectDimensionStatus(null)).toBeNull();
  });

  it('保留关闭时的清除报告', () => {
    const status = parseProjectDimensionStatus({
      ...disabled,
      purge: { removedSessions: 3, walTruncated: false },
    });
    expect(status?.purge).toEqual({ removedSessions: 3, walTruncated: false });
  });
});

describe('项目名显示', () => {
  const projects = [
    { key: 'n:secretclient', label: 'SecretClient', kind: 'named' as const },
    { key: '@home', label: null, kind: 'home' as const },
  ];

  it('隐藏时只用代称和固定分组名', () => {
    const aliases = projectAliasMap(projects, [], true);
    expect(projectDisplayName(projects[0], aliases, true)).toBe('项目 1');
    expect(projectDisplayName(projects[1], aliases, true)).toBe('主目录');
    expect(projectDisplayName(projects[0], aliases, true)).not.toContain('Secret');
  });

  it('未隐藏时显示文件夹名', () => {
    const aliases = projectAliasMap(projects, [], false);
    expect(projectDisplayName(projects[0], aliases, false)).toBe('SecretClient');
  });
});

describe('projectFailureCopy', () => {
  it('把截断未完成说成下次扫描再清', () => {
    expect(projectFailureCopy('purge_pending')).toContain('下次扫描');
  });
});
