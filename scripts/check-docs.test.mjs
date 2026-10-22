import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkTaskRows,
  evaluateArchiveRow,
  evaluateOverallConsistency,
  findCrossFileDuplicateIds,
  findStalePendingIndex,
  findUnindexedPending,
  parseTaskTable,
  selectLogSha,
} from './check-docs.mjs';

function row(overrides = {}) {
  return {
    id: 'T99.1',
    overall: '[v]',
    integration: 'merged-local',
    validation: 'platform-pending',
    ...overrides,
  };
}

// T10.211：归档行必须仍满足 [x] / merged-remote / complete 三条件，且带里程碑归属。
function archivableRow(overrides = {}) {
  return {
    id: 'T99.2',
    lineNo: 10,
    acceptance: '已完成并核验',
    overall: '[x]',
    integration: 'merged-remote',
    validation: 'complete',
    milestone: 'M9',
    ...overrides,
  };
}

test('archived rows share main-table ID, duplicate and acceptance validation', () => {
  const findings = [];
  const options = {
    reportFail: (rule, at) => findings.push({ rule, at }),
    reportWarn: () => {},
    checkMilestone: false,
  };
  checkTaskRows([
    archivableRow({ id: 'invalid', acceptance: '', lineNo: 10 }),
    archivableRow({ id: 'T99.2', lineNo: 11 }),
    archivableRow({ id: 'T99.2', lineNo: 12 }),
  ], 'docs/TASKS-archive.md', options);
  assert.deepEqual(findings, [
    { rule: 'task-id', at: 'docs/TASKS-archive.md:10' },
    { rule: 'acceptance', at: 'docs/TASKS-archive.md:10' },
    { rule: 'duplicate-id', at: 'docs/TASKS-archive.md:12' },
  ]);
});

test('Multica issue ids TOKE-N are accepted as task ids', () => {
  const findings = [];
  checkTaskRows([
    archivableRow({
      id: 'TOKE-14',
      overall: '[~]',
      integration: 'uncommitted',
      validation: 'not-run',
      lineNo: 3,
    }),
  ], 'docs/TASKS.md', {
    reportFail: (rule, at) => findings.push({ rule, at }),
    reportWarn: () => {},
    checkMilestone: false,
  });
  assert.deepEqual(findings, []);
});

test('[v] with a merged integration and a platform-pending validation is consistent', () => {
  assert.deepEqual(evaluateOverallConsistency(row()), []);
  assert.deepEqual(
    evaluateOverallConsistency(row({ integration: 'merged-remote', validation: 'target-device-passed' })),
    [],
  );
});

test('[v] must not sit on an unmerged branch or on local-passed validation', () => {
  const rules = evaluateOverallConsistency(row({ integration: 'committed', validation: 'local-passed' }))
    .map((finding) => finding.rule);
  assert.deepEqual(rules, ['v-integration', 'v-validation']);
});

test('other overall states are outside the [v] rule', () => {
  assert.deepEqual(evaluateOverallConsistency(row({ overall: '[r]', integration: 'committed' })), []);
  assert.deepEqual(evaluateOverallConsistency(row({ overall: '[x]', validation: 'complete' })), []);
});

test('log SHA selection prefers merge_sha, ignores null and placeholders', () => {
  const sha = 'a'.repeat(40);
  assert.equal(selectLogSha({ merge_sha: 'null', implementation_sha: sha }), sha);
  assert.equal(selectLogSha({ merge_sha: `\`${'b'.repeat(40)}\``, implementation_sha: sha }), 'b'.repeat(40));
  assert.equal(selectLogSha({ merge_sha: 'pending', implementation_sha: 'abc123' }), null);
  assert.equal(selectLogSha(null), null);
});

// ---------------------------------------------------------------- T10.211：归档相关纯函数

test('a row meeting all three archive conditions with a milestone has no findings', () => {
  assert.deepEqual(evaluateArchiveRow(archivableRow()), []);
});

test('an archived row failing the three conditions is flagged archive-criteria', () => {
  const rules = evaluateArchiveRow(archivableRow({ integration: 'merged-local' })).map((f) => f.rule);
  assert.deepEqual(rules, ['archive-criteria']);

  assert.deepEqual(
    evaluateArchiveRow(archivableRow({ overall: '[v]' })).map((f) => f.rule),
    ['archive-criteria'],
  );
  assert.deepEqual(
    evaluateArchiveRow(archivableRow({ validation: 'local-passed' })).map((f) => f.rule),
    ['archive-criteria'],
  );
  assert.deepEqual(
    evaluateArchiveRow(archivableRow({ overall: '[v]', integration: 'merged-local', validation: 'platform-pending' }))
      .map((f) => f.rule),
    ['archive-criteria'],
  );
  assert.deepEqual(
    evaluateArchiveRow(archivableRow({ overall: '[v]', validation: 'not-run' })).map((f) => f.rule),
    ['archive-criteria'],
  );
});

test('a pushed [v] row awaiting platform validation may be archived', () => {
  for (const validation of ['platform-pending', 'external-pending', 'target-device-passed']) {
    assert.deepEqual(evaluateArchiveRow(archivableRow({ overall: '[v]', validation })), [], validation);
  }
});

test('an archived [v] row must use the same validations as a main-table [v] row', () => {
  for (const validation of ['local-passed', 'blocked']) {
    assert.deepEqual(
      evaluateArchiveRow(archivableRow({ overall: '[v]', validation })).map((f) => f.rule),
      ['archive-criteria'],
      validation,
    );
  }
});

test('findUnindexedPending lists archived [v] rows missing from TASKS §6', () => {
  const taskLines = ['## 5. 其他', 'T99.9', '## 6. 平台待验清单', '| macOS | 1 | T99.2 |', '## 7. 尾'];
  const archived = [
    archivableRow({ id: 'T99.2', overall: '[v]', validation: 'platform-pending' }),
    archivableRow({ id: 'T99.3', overall: '[v]', validation: 'platform-pending' }),
    archivableRow({ id: 'T99.9', overall: '[v]', validation: 'platform-pending' }),
    archivableRow({ id: 'T99.4' }),
  ];
  assert.deepEqual(findUnindexedPending(taskLines, archived).map((r) => r.id), ['T99.3', 'T99.9']);
});

test('an archived row without a milestone is flagged milestone', () => {
  assert.deepEqual(evaluateArchiveRow(archivableRow({ milestone: null })).map((f) => f.rule), ['milestone']);
  assert.deepEqual(evaluateArchiveRow(archivableRow({ milestone: '' })).map((f) => f.rule), ['milestone']);
});

test('an archived row can fail both archive-criteria and milestone at once', () => {
  const rules = evaluateArchiveRow(archivableRow({ overall: '[~]', milestone: null })).map((f) => f.rule);
  assert.deepEqual(rules, ['archive-criteria', 'milestone']);
});

test('findCrossFileDuplicateIds returns only the main rows whose id is also archived', () => {
  const rows = [archivableRow({ id: 'A' }), archivableRow({ id: 'B' }), archivableRow({ id: 'C' })];
  const archiveRows = [archivableRow({ id: 'B' })];
  assert.deepEqual(findCrossFileDuplicateIds(rows, archiveRows).map((r) => r.id), ['B']);
});

test('findCrossFileDuplicateIds returns nothing when nothing overlaps', () => {
  assert.deepEqual(findCrossFileDuplicateIds([archivableRow({ id: 'A' })], []), []);
  assert.deepEqual(findCrossFileDuplicateIds([], [archivableRow({ id: 'A' })]), []);
});

test('parseTaskTable extracts id, milestone and unwrapped enum cells from a minimal table', () => {
  const lines = [
    '## 3. 任务表',
    '',
    '### M1 示例里程碑',
    '',
    '| ID | 目标 | 依赖 | 参考 | 总状态 | Integration | Validation | 验收 / 当前缺口 |',
    '|---|---|---|---|---|---|---|---|',
    '| T1.1 | 示例任务 | — | — | [x] | `merged-remote` | `complete` | 已完成 |',
  ];
  const rows = parseTaskTable(lines);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { id: rows[0].id, milestone: rows[0].milestone, integration: rows[0].integration, validation: rows[0].validation },
    { id: 'T1.1', milestone: 'M1', integration: 'merged-remote', validation: 'complete' },
  );
});

test('parseTaskTable accepts a custom label and skips malformed rows', () => {
  const lines = [
    '## 3. 任务表',
    '',
    '### M1 示例里程碑',
    '',
    '| ID | 目标 | 依赖 | 参考 | 总状态 | Integration | Validation | 验收 / 当前缺口 |',
    '|---|---|---|---|---|---|---|---|',
    '| T1.2 | 少一列的行 | — | — | [ ] | `not-started` | `not-run` |',
  ];
  assert.deepEqual(parseTaskTable(lines, 'docs/TASKS-archive.md'), []);
});

test('findStalePendingIndex lists §6 ids that are no longer archived [v] rows', () => {
  const taskLines = ['## 6. 平台待验清单', '', '| macOS | 2 | T99.2、T99.4 |', '说明里的 T99.5 不算', '## 7. 尾'];
  const archived = [
    archivableRow({ id: 'T99.2', overall: '[v]', validation: 'platform-pending' }),
    archivableRow({ id: 'T99.4' }),
  ];
  assert.deepEqual(findStalePendingIndex(taskLines, archived), [{ id: 'T99.4', lineNo: 3 }]);
});
