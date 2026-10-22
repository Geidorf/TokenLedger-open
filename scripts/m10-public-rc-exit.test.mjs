import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertM10PublicRcExit,
  assertReleaseLedgerForChannel,
} from './m10-public-rc-exit.mjs';

function ledger(overrides = {}, { omit = [] } = {}) {
  const rows = [];
  for (let index = 0; index <= 9; index += 1) {
    const id = `T10.${index}`;
    if (!omit.includes(id)) {
      const state = overrides[id] ?? ['[x]', 'merged-remote', 'complete'];
      rows.push(
        `| ${id} | fixture | deps | refs | ${state[0]} | \`${state[1]}\` | \`${state[2]}\` | closed |`,
      );
    }
  }
  rows.push(
    '| T10.7a | fixture subtask | deps | refs | [x] | `merged-remote` | `complete` | closed |',
  );
  rows.push(
    '| T10.7b | fixture subtask | deps | refs | [x] | `merged-remote` | `complete` | closed |',
  );
  return `
### M10 审计整改与公开 RC

| ID | 任务 | 依赖 | 关联 | 状态 | Integration | Validation | 验收 |
|---|---|---|---|---|---|---|---|
${rows.join('\n')}

## 4. 集成日志
`;
}

test('accepts every registered M10 task and subtask only at the frozen exit state', () => {
  assert.equal(assertM10PublicRcExit(ledger()).length, 12);
});

test('rejects incomplete status, local-only integration and pending validation', () => {
  assert.throws(
    () => assertM10PublicRcExit(ledger({ 'T10.2': ['[v]', 'merged-remote', 'complete'] })),
    /T10[.]2=\[v\]/,
  );
  assert.throws(
    () => assertM10PublicRcExit(ledger({ 'T10.4': ['[x]', 'merged-local', 'complete'] })),
    /T10[.]4=.*merged-local/,
  );
  assert.throws(
    () =>
      assertM10PublicRcExit(
        ledger({ 'T10.9': ['[x]', 'merged-remote', 'target-device-passed'] }),
      ),
    /T10[.]9=.*target-device-passed/,
  );
});

test('rejects a missing required M10 task even when all remaining rows are complete', () => {
  assert.throws(
    () => assertM10PublicRcExit(ledger({}, { omit: ['T10.6'] })),
    /missing required public RC task T10[.]6/,
  );
});

test('counts M10 rows archived to docs/TASKS-archive.md (T10.211)', () => {
  const main = ledger({}, { omit: ['T10.0', 'T10.1'] });
  const archive = ledger({}, { omit: ['T10.2', 'T10.3', 'T10.4', 'T10.5', 'T10.6', 'T10.7', 'T10.8', 'T10.9'] })
    .replace(/^\| T10[.]7[ab] .*\n/gm, '');
  // Without the archive the two closed tasks look missing and would block the release.
  assert.throws(() => assertM10PublicRcExit(main), /missing required public RC task T10[.]0/);
  assert.equal(assertM10PublicRcExit(main, archive).length, 12);
  assert.equal(assertReleaseLedgerForChannel('public-rc', main, archive).length, 12);
  // An archive without an M10 section adds nothing and is not an error.
  assert.equal(assertM10PublicRcExit(ledger(), '# 归档\n').length, 12);
  // The same ID in both files is still a duplicate.
  assert.throws(() => assertM10PublicRcExit(ledger(), archive), /duplicate M10 task ids/);
});

test('private signed rehearsal does not require the public RC ledger exit', () => {
  assert.deepEqual(
    assertReleaseLedgerForChannel('private-signed', ledger({
      'T10.9': ['[~]', 'committed', 'external-pending'],
    })),
    [],
  );
  assert.throws(
    () =>
      assertReleaseLedgerForChannel(
        'public-rc',
        ledger({ 'T10.9': ['[~]', 'committed', 'external-pending'] }),
      ),
    /public RC M10 exit is not closed/,
  );
});
