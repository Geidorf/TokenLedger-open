import { renderHook, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';
import {
  behaviorAnalysisForQuery,
  installDevMockTauri,
  mockBehaviorLedger,
  mockProjectIndex,
  mockProjectIndexKey,
  type MockBehaviorProjectOptions,
  type MockIndexedSession,
} from '../../devMockTauri';
import { useBehaviorAnalysis } from '../../hooks/useBehaviorAnalysis';
import type { BehaviorAnalysisResponse, BehaviorProjectDimensionState, LogHistoryItem } from '../../types';
import {
  BEHAVIOR_PROJECT_DIMENSION_DISABLED,
  BEHAVIOR_PROJECT_DIMENSION_UNAVAILABLE,
  BEHAVIOR_UNATTRIBUTED_FILTER_KEY,
  inspectBehaviorProjectFields,
  parseBehaviorProjectFields,
} from './behaviorProjects';

// 行为契约 v1.2 项目字段（T10.182）：前端解析失败即关闭，浏览器预览 mock 与原生聚合同规则。

const PARSER_SOURCE = Object.values(import.meta.glob<string>('./behaviorProjects.ts', { query: '?raw', import: 'default', eager: true }))[0];

const TOP_LEVEL_PROJECT_FIELDS = ['projects', 'projectLimit', 'projectsTruncated', 'projectsRemainder', 'unattributed'];

const WEBAPP = { key: 'n:sample-webapp', label: 'Sample-WebApp', kind: 'named' } as const;
const HOME = { key: '@home', label: null, kind: 'home' } as const;

function session(id: string, tool: string, tokens: number, requests: number, cost: number) {
  return { id, tool, tokens, requests, cost, firstAt: '2026-07-14 09:00:00', lastAt: '2026-07-14 10:00:00', topModel: `${tool}-model` };
}

/** A consistent v1.2 response: two projects plus unattributed usage partition the summary. */
function collecting(): BehaviorAnalysisResponse {
  return {
    meta: {
      source: 'local', complete: true, range: 'week', start: '2026-07-13', end: '2026-07-15', timezone: 'Asia/Shanghai',
      recordCount: 7, firstRecordAt: '2026-07-13 09:00:00', lastRecordAt: '2026-07-15 10:00:00', sessionLimit: 100,
      sessionsTruncated: false, rangeDayLimit: 731, rangeTruncated: false,
      projectDimension: { state: 'ready', indexedSessions: 4, pendingSessions: 0, filter: [] },
    },
    summary: {
      tokens: 1000, inputTokens: 800, outputTokens: 200, cachedTokens: 50, requests: 7, activeDays: 3, toolCount: 4,
      sessionCount: 4, modelCount: 4, unknownSessionRecords: 1, unknownSessionTokens: 50, totalCost: 0.5, costComplete: true,
    },
    tools: [
      { id: 'codex', tokens: 500, requests: 2, sessionCount: 1, unknownSessionRecords: 0 },
      { id: 'claude', tokens: 250, requests: 3, sessionCount: 2, unknownSessionRecords: 0 },
      { id: 'antigravity', tokens: 200, requests: 1, sessionCount: 1, unknownSessionRecords: 0 },
      { id: 'minimax', tokens: 50, requests: 1, sessionCount: 0, unknownSessionRecords: 1 },
    ],
    sessions: [
      { ...session('s-1', 'codex', 500, 2, 0.25), project: { ...WEBAPP } },
      { ...session('s-4', 'antigravity', 200, 1, 0.08), project: null, projectReason: 'unsupported_source' },
      { ...session('s-3', 'claude', 150, 2, 0.1), project: { ...HOME } },
      { ...session('s-2', 'claude', 100, 1, 0.05), project: { ...WEBAPP } },
    ],
    dayHours: [], modelHours: [], modelDays: [], requestSizes: [],
    projects: [
      { ...WEBAPP, tokens: 600, requests: 3, sessionCount: 2, cost: 0.3, share: 0.6, tools: [{ id: 'codex', tokens: 500 }, { id: 'claude', tokens: 100 }] },
      { ...HOME, tokens: 150, requests: 2, sessionCount: 1, cost: 0.1, share: 0.15, tools: [{ id: 'claude', tokens: 150 }] },
    ],
    projectLimit: 50,
    projectsTruncated: false,
    projectsRemainder: null,
    unattributed: {
      tokens: 250, requests: 2, sessionCount: 1, cost: 0.1, share: 0.25,
      reasons: [
        { reason: 'unsupported_source', tokens: 200, requests: 1, sessionCount: 1, share: 0.2 },
        { reason: 'missing_session', tokens: 50, requests: 1, sessionCount: null, share: 0.05 },
      ],
    },
  };
}

/** The same ledger answered by a backend without the project dimension (v1.1). */
function v11(): BehaviorAnalysisResponse {
  const response = collecting() as BehaviorAnalysisResponse & Record<string, unknown>;
  for (const field of TOP_LEVEL_PROJECT_FIELDS) delete response[field];
  delete response.meta.projectDimension;
  response.sessions = response.sessions.map(({ project: _project, projectReason: _reason, ...rest }) => rest);
  return response;
}

// Mutations are applied to a JSON copy; `any` keeps each case a one-liner.
type Draft = any;

function draft(mutate: (response: Draft) => void, base: () => BehaviorAnalysisResponse = collecting): BehaviorAnalysisResponse {
  const response = JSON.parse(JSON.stringify(base()));
  mutate(response);
  return response;
}

function expectNoProjectFields(response: BehaviorAnalysisResponse) {
  for (const field of TOP_LEVEL_PROJECT_FIELDS) expect(field in response).toBe(false);
  expect('projectDimension' in response.meta).toBe(false);
  for (const row of response.sessions) {
    expect('project' in row).toBe(false);
    expect('projectReason' in row).toBe(false);
  }
}

describe('行为契约 v1.2 项目字段解析（失败即关闭）', () => {
  it('合规的项目段原样保留', () => {
    const response = collecting();
    expect(inspectBehaviorProjectFields(response)).toEqual({ response: collecting(), problem: null });
    expect(parseBehaviorProjectFields(response)).toEqual(collecting());
  });

  it('旧后端（v1.1）的响应原样返回，不补任何项目字段', () => {
    const response = v11();
    const result = inspectBehaviorProjectFields(response);
    expect(result.problem).toBeNull();
    expect(result.response).toBe(response);
  });

  it('关闭与授权过低只保留状态；后续版本在关闭态新增的未知字段被忽略', () => {
    for (const state of ['disabled', 'consent_required'] as const) {
      const off = draft((response) => { response.meta.projectDimension = { state, note: 'later add-only field' }; }, v11);
      const result = inspectBehaviorProjectFields(off);
      expect(result.problem).toBeNull();
      expect(result.response.meta.projectDimension).toEqual({ state });
      expect(result.response.summary).toEqual(off.summary);
    }
  });

  it('关闭态带任何项目内容时整段丢弃', () => {
    const leaks: Array<(response: Draft) => void> = [
      (response) => { response.projects = []; },
      (response) => { response.unattributed = collecting().unattributed; },
      (response) => { response.meta.projectDimension.indexedSessions = 0; },
      (response) => { response.meta.projectDimension.filter = []; },
      (response) => { response.sessions[0].project = null; response.sessions[0].projectReason = 'pending'; },
    ];
    for (const leak of leaks) {
      const response = draft((value) => { value.meta.projectDimension = { state: 'disabled' }; leak(value); }, v11);
      const result = inspectBehaviorProjectFields(response);
      expect(result.problem).toBe('project-data-while-off');
      expectNoProjectFields(result.response);
      expect(result.response.summary).toEqual(response.summary);
    }
  });

  it('只输出已知字段：未知键（例如路径）不会穿过解析', () => {
    const response = draft((value) => {
      value.projects[0].path = '/home/demo/sample-webapp';
      value.sessions[0].project.path = '/home/demo/sample-webapp';
      value.unattributed.detail = 'free text';
      value.unattributed.reasons[0].sources = ['antigravity'];
      value.meta.projectDimension.workdir = '/home/demo';
    });
    const result = inspectBehaviorProjectFields(response);
    expect(result.problem).toBeNull();
    expect(result.response).toEqual(collecting());
    expect(JSON.stringify(result.response)).not.toContain('/home/demo');
  });

  it('截断的排行带诚实的余量；余量里的项目仍可出现在会话上', () => {
    const response = draft((value) => {
      value.projectLimit = 1;
      value.projectsTruncated = true;
      value.projects = [value.projects[0]];
      value.projectsRemainder = { tokens: 150, requests: 2, sessionCount: 1, cost: 0.1, share: 0.15, projectCount: 1 };
    });
    const result = inspectBehaviorProjectFields(response);
    expect(result.problem).toBeNull();
    expect(result.response.projectsRemainder).toEqual(response.projectsRemainder);
  });

  it('区间有效 Token 为 0 时占比不可得（null），不是 0', () => {
    const zero = (): BehaviorAnalysisResponse => draft((value) => {
      value.meta.projectDimension.indexedSessions = 1;
      value.summary = { ...value.summary, tokens: 0, inputTokens: 0, outputTokens: 0, requests: 1, sessionCount: 1,
        unknownSessionRecords: 0, unknownSessionTokens: 0, totalCost: 0.01 };
      value.sessions = [{ ...session('s-1', 'codex', 0, 1, 0.01), project: { ...WEBAPP } }];
      value.projects = [{ ...WEBAPP, tokens: 0, requests: 1, sessionCount: 1, cost: 0.01, share: null, tools: [{ id: 'codex', tokens: 0 }] }];
      value.unattributed = { tokens: 0, requests: 0, sessionCount: 0, cost: 0, share: null, reasons: [] };
    });
    expect(inspectBehaviorProjectFields(zero()).problem).toBeNull();
    expect(inspectBehaviorProjectFields(draft((value) => { value.projects[0].share = 0; }, zero)).problem).toBe('invalid-project-share');
    expect(inspectBehaviorProjectFields(draft((value) => { value.unattributed.share = 0; }, zero)).problem).toBe('invalid-unattributed');
  });

  it('失败状态只透传两个固定原因码；其他值一律按未知失败（null）处理，不丢整段', () => {
    const failed = (lastFailure: unknown) => draft((value) => {
      value.meta.projectDimension = { ...value.meta.projectDimension, state: 'failed', lastFailure };
    });
    const expected = (lastFailure: string | null) => ({ ...collecting().meta.projectDimension, state: 'failed', lastFailure });
    for (const lastFailure of ['database_error', 'internal_error', null]) {
      const result = inspectBehaviorProjectFields(failed(lastFailure));
      expect(result.problem).toBeNull();
      expect(result.response.meta.projectDimension).toEqual(expected(lastFailure));
    }
    for (const lastFailure of ['demo_account', 'open C:/Users/demo/app.db failed', 42, { code: 'database_error' }]) {
      const result = inspectBehaviorProjectFields(failed(lastFailure));
      expect(result.problem).toBeNull();
      expect(result.response.meta.projectDimension).toEqual(expected(null));
      expect(result.response.projects).toEqual(collecting().projects);
      expect(JSON.stringify(result.response)).not.toContain('demo');
    }
  });

  it('不变量 6 只在响应带 v1.1 未知会话字段时核对', () => {
    const response = draft((value) => {
      delete value.summary.unknownSessionRecords;
      delete value.summary.unknownSessionTokens;
    });
    expect(inspectBehaviorProjectFields(response)).toEqual({ response, problem: null });
  });

  it('不变量 7 只约束未筛选的响应：筛选后的覆盖计数仍是全区间的', () => {
    const response = draft((value) => {
      value.meta.projectDimension = { ...value.meta.projectDimension, indexedSessions: 9, pendingSessions: 2, filter: ['@home', 'n:sample-webapp'] };
    });
    expect(inspectBehaviorProjectFields(response)).toEqual({ response, problem: null });
  });

  it('占比按 Token ÷ 区间合计核对，只容许相对 1e-9 以内的浮点误差', () => {
    const noisy = draft((value) => {
      value.projects[0].share = 0.6 + 1e-13;
      value.unattributed.reasons[1].share = 0.05 - 1e-14;
    });
    expect(inspectBehaviorProjectFields(noisy)).toEqual({ response: noisy, problem: null });
    expect(inspectBehaviorProjectFields(draft((value) => { value.projects[0].share = 0.6 * (1 + 1e-8); })).problem).toBe('share-mismatch');
    expect(inspectBehaviorProjectFields(draft((value) => { value.unattributed.reasons[0].share = 0.25; })).problem).toBe('share-mismatch');
  });

  it('解析器源码不含原始的控制字符或双向字符，一律写成 \\u 转义（评审 P2-1）', () => {
    expect(PARSER_SOURCE).toContain('\\u202a-\\u202e\\u2066-\\u2069');
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(PARSER_SOURCE)).toBe(false);
  });

  const violations: Array<[string, (response: Draft) => void, string]> = [
    ['未知状态', (value) => { value.meta.projectDimension.state = 'paused'; }, 'invalid-state'],
    ['缺少状态却带项目字段', (value) => { delete value.meta.projectDimension; }, 'project-data-without-state'],
    ['筛选回显不是字符串', (value) => { value.meta.projectDimension.filter = [1]; }, 'invalid-filter'],
    ['覆盖计数为负', (value) => { value.meta.projectDimension.indexedSessions = -1; }, 'invalid-coverage'],
    ['非失败状态带失败原因', (value) => { value.meta.projectDimension.lastFailure = 'database_error'; }, 'invalid-last-failure'],
    ['项目名像路径（斜杠）', (value) => { value.projects[0].label = 'work/sample-webapp'; }, 'invalid-project-label'],
    ['项目名含盘符与反斜杠', (value) => { value.projects[0].label = 'C:\\Users\\demo'; }, 'invalid-project-label'],
    ['项目名含控制字符', (value) => { value.projects[0].label = 'sample\u0007webapp'; }, 'invalid-project-label'],
    ['项目名含双向控制字符', (value) => { value.projects[0].label = 'sample\u202ewebapp'; }, 'invalid-project-label'],
    ['项目名为空白', (value) => { value.projects[0].label = '   '; }, 'invalid-project-label'],
    ['键是路径哈希而不是名称键', (value) => { value.projects[0].key = 'h:9f86d081884c7d65'; }, 'invalid-project-key'],
    ['键含路径分隔符', (value) => { value.projects[0].key = 'n:work/sample-webapp'; }, 'invalid-project-key'],
    ['名称键带哈希而不是名称', (value) => { value.projects[0].key = 'n:9f86d081884c7d65'; }, 'project-key-mismatch'],
    ['名称键是小写的盘符路径', (value) => { value.projects[0].key = 'n:c:users'; }, 'project-key-mismatch'],
    ['会话上的名称键与名称不一致', (value) => { value.sessions[0].project.key = 'n:9f86d081884c7d65'; }, 'project-key-mismatch'],
    ['固定分组带名称', (value) => { value.projects[1].label = 'demo'; }, 'invalid-group-ref'],
    ['固定分组键与类别不符', (value) => { value.projects[1].key = '@temp'; }, 'invalid-group-ref'],
    ['未知类别', (value) => { value.projects[1].kind = 'folder'; }, 'invalid-project-kind'],
    ['重复项目键', (value) => { value.projects[1] = { ...value.projects[0] }; }, 'duplicate-project-key'],
    ['Token 为负', (value) => { value.projects[0].tokens = -1; }, 'invalid-project-totals'],
    ['会话数不是整数', (value) => { value.projects[0].sessionCount = 1.5; }, 'invalid-project-totals'],
    ['费用为负', (value) => { value.projects[0].cost = -0.1; }, 'invalid-project-cost'],
    ['占比超过 1', (value) => { value.projects[0].share = 1.5; }, 'invalid-project-share'],
    ['工具构成缺 id', (value) => { value.projects[0].tools = [{ tokens: 500 }]; }, 'invalid-project-tools'],
    ['超过 projectLimit', (value) => { value.projectLimit = 1; }, 'invalid-project-limit'],
    ['截断却没有余量', (value) => { value.projectsTruncated = true; }, 'invalid-remainder'],
    ['未截断却有余量', (value) => {
      value.projectsRemainder = { tokens: 0, requests: 0, sessionCount: 0, cost: 0, share: 0, projectCount: 1 };
    }, 'invalid-remainder'],
    ['缺少未归属', (value) => { delete value.unattributed; }, 'invalid-unattributed'],
    ['未知原因', (value) => { value.unattributed.reasons[1].reason = 'other'; }, 'invalid-unattributed-reason'],
    ['原因重复', (value) => { value.unattributed.reasons[1].reason = 'unsupported_source'; }, 'invalid-unattributed-reason'],
    ['缺少会话 ID 的会话数写成 0', (value) => { value.unattributed.reasons[1].sessionCount = 0; }, 'invalid-unattributed-reason'],
    ['Token 分区对不上', (value) => { value.projects[0].tokens = 599; }, 'partition-mismatch'],
    ['会话数分区对不上', (value) => { value.unattributed.sessionCount = 2; }, 'partition-mismatch'],
    ['原因之和对不上', (value) => { value.unattributed.reasons[0].tokens = 199; }, 'reason-mismatch'],
    ['部分费用不可得而合计可得（只加已知部分）', (value) => { value.projects[1].cost = null; }, 'cost-mismatch'],
    ['合计不可得而各部分都可得', (value) => { value.summary.totalCost = null; value.summary.costComplete = false; }, 'cost-mismatch'],
    ['项目占比与 Token 不符', (value) => { value.projects[0].share = 0.5; }, 'share-mismatch'],
    ['缺少会话 ID 的 Token 与 v1.1 未知会话 Token 不符', (value) => { value.summary.unknownSessionTokens = 49; }, 'missing-session-mismatch'],
    ['缺少会话 ID 的请求与 v1.1 未知会话记录不符', (value) => { value.summary.unknownSessionRecords = 2; }, 'missing-session-mismatch'],
    ['未筛选时覆盖计数之和不等于会话数', (value) => { value.meta.projectDimension.pendingSessions = 3; }, 'coverage-mismatch'],
    ['未筛选时尚未索引的会话数与原因行不符', (value) => {
      value.meta.projectDimension.indexedSessions = 3;
      value.meta.projectDimension.pendingSessions = 1;
    }, 'coverage-mismatch'],
    ['会话缺 project 字段', (value) => { delete value.sessions[0].project; }, 'invalid-session-project'],
    ['会话原因是缺少会话 ID', (value) => { value.sessions[1].projectReason = 'missing_session'; }, 'invalid-session-project'],
    ['会话同时有项目与原因', (value) => { value.sessions[0].projectReason = 'unresolved'; }, 'invalid-session-project'],
    ['会话与排行名称不一致', (value) => { value.sessions[0].project.label = 'sample-webapp'; }, 'session-project-mismatch'],
    ['会话项目不在未截断的排行里', (value) => {
      value.sessions[0].project = { key: 'n:other', label: 'other', kind: 'named' };
    }, 'session-project-mismatch'],
    ['会话原因未在未归属中列出', (value) => { value.sessions[1].projectReason = 'pending'; }, 'session-project-mismatch'],
  ];

  it.each(violations)('%s：整段项目字段丢弃，v1.1 字段不受影响', (_name, mutate, problem) => {
    const response = draft(mutate);
    const result = inspectBehaviorProjectFields(response);
    expect(result.problem).toBe(problem);
    expectNoProjectFields(result.response);
    expect(result.response.summary).toEqual(response.summary);
    expect(result.response.tools).toEqual(response.tools);
    expect(result.response.sessions.map((row) => row.id)).toEqual(['s-1', 's-4', 's-3', 's-2']);
    expect(parseBehaviorProjectFields(response)).toEqual(result.response);
  });
});

// The browser preview mock must follow the native aggregation (commands/mod.rs).
// Calendar values use the host zone, as in useBehaviorAnalysis.mock.test.ts.
const HOST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
// The preview clock: 2026-07-15 14:30 host time.
const MOCK_NOW = new Date(2026, 6, 15, 14, 30, 0, 0);
const COLLECTING_STATES = ['indexing', 'ready', 'failed'] as const;

function analyse(query: Record<string, unknown>, ledger?: LogHistoryItem[], options?: MockBehaviorProjectOptions): BehaviorAnalysisResponse {
  return behaviorAnalysisForQuery({ timezone: HOST_ZONE, ...query }, ledger, options) as BehaviorAnalysisResponse;
}

/** Projects, remainder and unattributed partition the summary; the parser accepts the response unchanged. */
function expectPartition(result: BehaviorAnalysisResponse) {
  const projects = result.projects ?? [];
  const other = result.unattributed!;
  for (const field of ['tokens', 'requests', 'sessionCount'] as const) {
    const sum = projects.reduce((value, project) => value + project[field], 0) + (result.projectsRemainder?.[field] ?? 0) + other[field];
    expect(sum).toBe(result.summary[field]);
    expect(other.reasons.reduce((value, row) => value + (row[field] ?? 0), 0)).toBe(other[field]);
  }
  const share = (tokens: number) => (result.summary.tokens > 0 ? tokens / result.summary.tokens : null);
  for (const part of [...projects, other, ...other.reasons]) expect(part.share).toBe(share(part.tokens));
  // Records without a session ID are the v1.1 unknown-session records.
  const missing = other.reasons.find((row) => row.reason === 'missing_session');
  expect(missing?.requests ?? 0).toBe(result.summary.unknownSessionRecords);
  expect(missing?.tokens ?? 0).toBe(result.summary.unknownSessionTokens);
  expect(missing?.sessionCount ?? null).toBeNull();
  const inspected = inspectBehaviorProjectFields(result);
  expect(inspected.problem).toBeNull();
  expect(inspected.response).toEqual(result);
}

/** The filter key selecting a session's stored place (a pending session is unattributed). */
function filterKeyOf(entry: MockIndexedSession | undefined): string {
  if (!entry || entry.kind === 'unresolved') return BEHAVIOR_UNATTRIBUTED_FILTER_KEY;
  return entry.kind === 'named' ? `n:${entry.label.toLowerCase()}` : `@${entry.kind}`;
}

function row(id: number, tool: string, sessionId: string, tokens: number, cost: number): LogHistoryItem {
  return {
    id, tool, model: `${tool}-model`, inputTokens: tokens, outputTokens: 0, cachedTokens: 0, cost,
    timestamp: new Date(2026, 6, 15, 9, 0, id).toISOString(), sessionId, machineId: 'Studio-PC',
  };
}

function namedIndex(entries: Array<[string, string, MockIndexedSession]>, state: BehaviorProjectDimensionState = 'ready') {
  return { state, lastFailure: null, sessions: new Map(entries.map(([tool, id, entry]) => [mockProjectIndexKey(tool, id), entry])) };
}

describe('浏览器预览 mock 的项目维度与原生聚合同规则', () => {
  it('默认关闭：只报告状态，不输出项目字段', () => {
    const result = analyse({ range: 'month' });
    expect(result.meta.projectDimension).toEqual({ state: 'disabled' });
    expect(TOP_LEVEL_PROJECT_FIELDS.some((field) => field in result)).toBe(false);
    expect(result.sessions.some((item) => 'project' in item || 'projectReason' in item)).toBe(false);
    expect(inspectBehaviorProjectFields(result)).toEqual({ response: result, problem: null });
  });

  it('授权版本过低时不显示已存的索引行', () => {
    const index = mockProjectIndex('consent_required');
    expect(index.sessions.size).toBeGreaterThan(0);
    const result = analyse({ range: 'month' }, undefined, { index });
    expect(result.meta.projectDimension).toEqual({ state: 'consent_required' });
    expect(TOP_LEVEL_PROJECT_FIELDS.some((field) => field in result)).toBe(false);
  });

  it('未采集时非空筛选报 project_dimension_disabled，空筛选等于不筛选', () => {
    for (const index of [undefined, mockProjectIndex('disabled'), mockProjectIndex('consent_required')]) {
      for (const projects of [['n:sample-webapp'], [BEHAVIOR_UNATTRIBUTED_FILTER_KEY]]) {
        expect(() => analyse({ range: 'month' }, undefined, { index, projects })).toThrow(BEHAVIOR_PROJECT_DIMENSION_DISABLED);
      }
      for (const projects of [[], null, undefined]) {
        expect(analyse({ range: 'month' }, undefined, { index, projects }).meta.projectDimension).toEqual({ state: index?.state ?? 'disabled' });
      }
    }
  });

  it('索引读不出来：不带筛选时省略 projectDimension、其余字段与 v1.1 相同，带筛选报 project_dimension_unavailable', () => {
    const ledger = mockBehaviorLedger('default');
    const { meta: { projectDimension: _off, ...v11Meta }, ...v11Rest } = analyse({ range: 'month' }, ledger);
    for (const index of [undefined, mockProjectIndex('disabled', ledger), ...COLLECTING_STATES.map((state) => mockProjectIndex(state, ledger))]) {
      for (const projects of [[], null, undefined]) {
        const result = analyse({ range: 'month' }, ledger, { index, projects, unreadable: true });
        expect('projectDimension' in result.meta).toBe(false);
        expect(result).toEqual({ ...v11Rest, meta: v11Meta });
        expectNoProjectFields(result);
        expect(inspectBehaviorProjectFields(result)).toEqual({ response: result, problem: null });
      }
      for (const projects of [['n:sample-webapp'], [BEHAVIOR_UNATTRIBUTED_FILTER_KEY]]) {
        expect(() => analyse({ range: 'month' }, ledger, { index, projects, unreadable: true })).toThrow(BEHAVIOR_PROJECT_DIMENSION_UNAVAILABLE);
      }
    }
  });

  it('各采集状态、场景与范围都分区一致并通过解析', () => {
    for (const state of COLLECTING_STATES) {
      for (const scenario of ['default', 'edge'] as const) {
        const ledger = mockBehaviorLedger(scenario);
        const index = mockProjectIndex(state, ledger);
        for (const range of ['today', 'week', 'month', 'all']) {
          const result = analyse({ range }, ledger, { index });
          expectPartition(result);
          const dimension = result.meta.projectDimension!;
          expect(dimension).toMatchObject({ state, filter: [] });
          expect('lastFailure' in dimension).toBe(state === 'failed');
          if (state === 'failed') expect(dimension).toHaveProperty('lastFailure', 'database_error');
          // Coverage counts every real session once: indexed or not yet.
          const coverage = dimension as { indexedSessions: number; pendingSessions: number };
          expect(coverage.indexedSessions + coverage.pendingSessions).toBe(result.summary.sessionCount);
          const pending = result.unattributed!.reasons.find((item) => item.reason === 'pending');
          expect(pending?.sessionCount ?? 0).toBe(coverage.pendingSessions);
        }
      }
    }
  });

  it('四类未归属按固定顺序分列：来源不支持、无法确定、尚未索引、缺少会话 ID', () => {
    const ledger = mockBehaviorLedger('edge');
    const result = analyse({ range: 'month' }, ledger, { index: mockProjectIndex('ready', ledger) });
    const reasons = result.unattributed!.reasons;
    expect(reasons.map((item) => item.reason)).toEqual(['unsupported_source', 'unresolved', 'pending', 'missing_session']);
    // Every Antigravity session is indexed by now, and its source records no working directory.
    const antigravity = result.tools.find((tool) => tool.id === 'antigravity')!;
    expect(reasons[0]).toMatchObject({ tokens: antigravity.tokens, requests: antigravity.requests, sessionCount: antigravity.sessionCount });
    // `ready` lacks only the sessions that started after the latest pass (the last hour).
    const lastPass = MOCK_NOW.getTime() - 3_600_000;
    const recent = ledger.filter((item) => {
      const at = Date.parse(item.timestamp);
      return at > lastPass && at <= MOCK_NOW.getTime() && item.sessionId.trim() !== '' && item.sessionId !== 'unknown_session';
    });
    expect(recent.length).toBeGreaterThan(0);
    expect(reasons[2]).toMatchObject({
      tokens: recent.reduce((sum, item) => sum + item.inputTokens + item.outputTokens, 0), requests: recent.length, sessionCount: recent.length,
    });
    // The edge scenario's MiniMax rows carry the placeholder session ID.
    expect(reasons[3]).toMatchObject({ requests: result.summary.unknownSessionRecords, sessionCount: null });
    expect(result.projects!.some((project) => project.tools.some((tool) => tool.id === 'antigravity' || tool.id === 'minimax'))).toBe(false);
  });

  it('只用虚构文件夹名；标签取全索引多数写法，键不随写法变化', () => {
    const ledger = mockBehaviorLedger('default');
    const index = mockProjectIndex('ready', ledger);
    const result = analyse({ range: 'all' }, ledger, { index });
    const keys = result.projects!.map((project) => project.key);
    for (const key of keys) expect(key).toMatch(/^(n:[a-z-]+|@(home|root|temp|managed))$/);
    expect(new Set(result.projects!.filter((project) => project.kind === 'named').map((project) => project.label)))
      .toEqual(new Set(['sample-webapp', 'Demo-CLI', 'example-docs', 'toy-compiler', 'data-notebook']));
    expect(keys).toEqual(expect.arrayContaining(['n:demo-cli', '@home', '@managed', '@temp', '@root']));
    const spellings = [...index.sessions.values()].filter((entry) => entry.kind === 'named' && entry.label.toLowerCase() === 'demo-cli');
    expect(new Set(spellings.map((entry) => (entry.kind === 'named' ? entry.label : '')))).toEqual(new Set(['Demo-CLI', 'demo-cli']));
    expect(result.projects!.find((project) => project.key === 'n:demo-cli')?.label).toBe('Demo-CLI');
  });

  it('任一入选记录费用不可得时该项与合计为 null，不只加已知部分', () => {
    const ledger = mockBehaviorLedger('edge');
    const index = mockProjectIndex('ready', ledger);
    const result = analyse({ range: 'week' }, ledger, { index });
    // The corrupt cost sits on an Antigravity record: unattributed, never a project.
    expect(result.unattributed!.cost).toBeNull();
    expect(result.summary.totalCost).toBeNull();
    expect(result.projects!.every((project) => typeof project.cost === 'number')).toBe(true);
    const named = result.projects!.map((project) => project.key);
    const projectsOnly = analyse({ range: 'week' }, ledger, { index, projects: named });
    expect(projectsOnly.unattributed).toMatchObject({ tokens: 0, requests: 0, sessionCount: 0, cost: 0, reasons: [] });
    expect(projectsOnly.summary.totalCost).toBeCloseTo(result.projects!.reduce((sum, project) => sum + (project.cost ?? Number.NaN), 0), 9);
    expectPartition(projectsOnly);
  });

  it('项目筛选作用于所有维度；覆盖计数不受筛选影响', () => {
    const ledger = mockBehaviorLedger('default');
    const index = mockProjectIndex('ready', ledger);
    const all = analyse({ range: 'month' }, ledger, { index });
    const top = all.projects![0];
    const only = analyse({ range: 'month' }, ledger, { index, projects: ['n:no-such-project', top.key, top.key] });
    expect(only.meta.projectDimension).toEqual({
      ...all.meta.projectDimension,
      filter: [top.key, 'n:no-such-project'].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    });
    expect(only.summary).toMatchObject({ tokens: top.tokens, requests: top.requests, sessionCount: top.sessionCount });
    expect(only.projects).toEqual([{ ...top, share: 1 }]);
    expect(only.sessions.every((item) => item.project?.key === top.key)).toBe(true);
    expect(only.tools.reduce((sum, tool) => sum + tool.tokens, 0)).toBe(top.tokens);
    expect(only.dayHours.reduce((sum, bucket) => sum + bucket.tokens, 0)).toBe(top.tokens);
    expectPartition(only);

    const rest = analyse({ range: 'month' }, ledger, { index, projects: [BEHAVIOR_UNATTRIBUTED_FILTER_KEY] });
    expect(rest.projects).toEqual([]);
    expect(rest.summary.tokens).toBe(all.unattributed!.tokens);
    expect(rest.unattributed!.reasons.map(({ reason, tokens }) => ({ reason, tokens })))
      .toEqual(all.unattributed!.reasons.map(({ reason, tokens }) => ({ reason, tokens })));
    expectPartition(rest);
  });

  it('`all` 的截断判断同样遵循项目筛选', () => {
    const ledger = mockBehaviorLedger('edge');
    const index = mockProjectIndex('ready', ledger);
    const archived = ledger.find((item) => item.sessionId === 'session-archived')!;
    const key = filterKeyOf(index.sessions.get(mockProjectIndexKey(archived.tool, archived.sessionId)));
    expect(analyse({ range: 'all' }, ledger, { index }).meta.rangeTruncated).toBe(true);
    expect(analyse({ range: 'all' }, ledger, { index, projects: [key] }).meta.rangeTruncated).toBe(true);
    const other = key === BEHAVIOR_UNATTRIBUTED_FILTER_KEY ? 'n:sample-webapp' : BEHAVIOR_UNATTRIBUTED_FILTER_KEY;
    expect(analyse({ range: 'all' }, ledger, { index, projects: [other] }).meta.rangeTruncated).toBe(false);
  });

  it('排行最多 50 个，其余合并为余量，余量费用同样遵循 GLB-01', () => {
    // 53 sessions, each its own project; the smallest one has an unusable cost.
    const ledger = Array.from({ length: 53 }, (_, index) => row(index + 1, 'codex', `s-${index + 1}`, 1000 + index * 10, index === 0 ? Number.NaN : 0.01))
      .reverse();
    const index = namedIndex(ledger.map((item) => [item.tool, item.sessionId, { kind: 'named', label: `proj-${item.sessionId.slice(2).padStart(2, '0')}` }]));
    const result = analyse({ range: 'today' }, ledger, { index });
    expect(result.projectLimit).toBe(50);
    expect(result.projects).toHaveLength(50);
    expect(result.projects![0].key).toBe('n:proj-53');
    expect(result.projectsTruncated).toBe(true);
    expect(result.projectsRemainder).toEqual({
      tokens: 1000 + 1010 + 1020, requests: 3, sessionCount: 3, cost: null, share: 3030 / result.summary.tokens, projectCount: 3,
    });
    expect(result.projects!.every((project) => typeof project.cost === 'number')).toBe(true);
    expect(result.summary.totalCost).toBeNull();
    expectPartition(result);
  });

  it('区间有效 Token 为 0 时占比为 null', () => {
    const ledger = [row(2, 'antigravity', 'ag-1', 0, 0), row(1, 'codex', 's-1', 0, 0)];
    const index = namedIndex([['codex', 's-1', { kind: 'named', label: 'sample-webapp' }], ['antigravity', 'ag-1', { kind: 'unresolved', unsupportedSource: true }]]);
    const result = analyse({ range: 'today' }, ledger, { index });
    expect(result.summary.tokens).toBe(0);
    expect(result.projects![0].share).toBeNull();
    expect(result.unattributed!.share).toBeNull();
    expectPartition(result);
  });
});

describe('浏览器预览 IPC 与 hook 的解析入口', () => {
  const query = { range: 'month', timezone: HOST_ZONE, machines: [], tools: [], models: [], search: null, tokenMode: 'effective' };

  afterEach(() => {
    clearMocks();
    window.history.replaceState(null, '', '/');
  });

  it('未采集时带筛选以裸错误码拒绝；?behaviorProjects 预览采集状态', async () => {
    clearMocks();
    installDevMockTauri();
    await expect(invoke('get_local_behavior_analysis', { query, projects: ['n:sample-webapp'] })).rejects.toBe(BEHAVIOR_PROJECT_DIMENSION_DISABLED);
    const off = await invoke<BehaviorAnalysisResponse>('get_local_behavior_analysis', { query });
    expect(off.meta.projectDimension).toEqual({ state: 'disabled' });

    window.history.replaceState(null, '', '/?behaviorProjects=ready');
    const ready = await invoke<BehaviorAnalysisResponse>('get_local_behavior_analysis', { query });
    expect(ready.meta.projectDimension?.state).toBe('ready');
    expectPartition(ready);
    const unattributed = await invoke<BehaviorAnalysisResponse>('get_local_behavior_analysis', { query, projects: [BEHAVIOR_UNATTRIBUTED_FILTER_KEY] });
    expect(unattributed.projects).toEqual([]);
  });

  it('?behaviorProjects=unavailable 预览索引读不出来：带筛选以裸错误码拒绝，不带筛选按「后端不支持」原样放行', async () => {
    clearMocks();
    installDevMockTauri();
    window.history.replaceState(null, '', '/?behaviorProjects=unavailable');
    await expect(invoke('get_local_behavior_analysis', { query, projects: ['n:sample-webapp'] })).rejects.toBe(BEHAVIOR_PROJECT_DIMENSION_UNAVAILABLE);
    const reply = await invoke<BehaviorAnalysisResponse>('get_local_behavior_analysis', { query });
    expect('projectDimension' in reply.meta).toBe(false);
    expectNoProjectFields(reply);
    expect(inspectBehaviorProjectFields(reply)).toEqual({ response: reply, problem: null });
  });

  it('hook 解析一次：合规项目段保留，坏的项目段整段丢弃，其余照常显示', async () => {
    const render = async (response: BehaviorAnalysisResponse) => {
      clearMocks();
      mockIPC((cmd) => (cmd === 'get_local_behavior_analysis' ? response : null));
      const { result, unmount } = renderHook(() => useBehaviorAnalysis({ scope: 'local', range: 'week', customRange: null, timezone: 'Asia/Shanghai' }));
      await waitFor(() => expect(result.current.data).not.toBeNull());
      const data = result.current.data!;
      expect(result.current.error).toBe('');
      unmount();
      return data;
    };
    expect(await render(collecting())).toEqual(collecting());
    const broken = draft((value) => { value.projects[0].label = 'C:\\Users\\demo\\sample-webapp'; });
    const shown = await render(broken);
    expectNoProjectFields(shown);
    expect(shown.summary).toEqual(broken.summary);
    expect(shown.sessions).toHaveLength(4);
  });

  it('预览开关默认关闭；开启后行为分析带项目字段，关闭后清除且不再返回项目（TOKE-13）', async () => {
    clearMocks();
    installDevMockTauri();
    window.history.replaceState(null, '', '/');
    const initial = await invoke<{ enabled: boolean; state: string }>('get_project_dimension_status');
    expect(initial).toMatchObject({ enabled: false, state: 'disabled' });
    await expect(invoke('set_project_dimension', { enabled: true, consentVersion: 0 })).rejects.toBe('consent_version_mismatch');

    const opened = await invoke<{ enabled: boolean; namedProjects: number }>('set_project_dimension', { enabled: true, consentVersion: 1 });
    expect(opened.enabled).toBe(true);
    expect(opened.namedProjects).toBeGreaterThan(0);
    const ready = await invoke<BehaviorAnalysisResponse>('get_local_behavior_analysis', { query });
    expect(ready.meta.projectDimension?.state).toBe('ready');
    expect(ready.projects?.length).toBeGreaterThan(0);

    const closed = await invoke<{ enabled: boolean; purge?: { removedSessions: number; walTruncated: boolean } }>('set_project_dimension', { enabled: false });
    expect(closed.enabled).toBe(false);
    expect(closed.purge).toEqual({ removedSessions: 12, walTruncated: true });
    const off = await invoke<BehaviorAnalysisResponse>('get_local_behavior_analysis', { query });
    expect(off.meta.projectDimension).toEqual({ state: 'disabled' });
    expect(off.projects).toBeUndefined();
  });
});
