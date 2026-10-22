import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'archive-tasks.mjs');

const TASK_HEADER = '| ID | 任务 | 依赖 | 需求 | 状态 | Integration | Validation | 验收 / 当前缺口 |';
const TASK_SEP = '|---|---|---|---|---|---|---|---|';
const CLAIM_HEADER = '| 任务 | Owner | Branch | Integration |';
const CLAIM_SEP = '|---|---|---|---|';

function taskRow(id, overall, integration, validation) {
  return `| ${id} | 任务 ${id} | — | — | ${overall} | \`${integration}\` | \`${validation}\` | 证据 |`;
}

function fixture() {
  return [
    '# 台账',
    '',
    '## 1. 里程碑',
    '',
    '| 里程碑 | 目标 | 出口条件 |',
    '|---|---|---|',
    '| M1 示例 | 目标 | 条件 |',
    '',
    '## 2. 活跃认领',
    '',
    CLAIM_HEADER,
    CLAIM_SEP,
    '| T1.1 | a | codex/T1.1 | `merged-remote` |',
    '| T1.2 | a | codex/T1.2 | `merged-remote` |',
    '| T1.3 | a | codex/T1.3 | `merged-remote` |',
    '| T1.4 | a | codex/T1.4 | `committed` |',
    '| T1.5 | a | codex/T1.5 | `committed` |',
    '',
    '### 2.1 Remote Handoff Readiness',
    '',
    '| Ref | localHead |',
    '|---|---|',
    '| `main` | `abc` |',
    '',
    '## 3. 任务表',
    '',
    '### M1 示例',
    '',
    TASK_HEADER,
    TASK_SEP,
    taskRow('T1.1', '[x]', 'merged-remote', 'complete'),
    taskRow('T1.2', '[v]', 'merged-remote', 'platform-pending'),
    taskRow('T1.3', '[~]', 'merged-remote', 'local-passed'),
    taskRow('T1.4', '[r]', 'committed', 'local-passed'),
    taskRow('T1.5', '[r]', 'committed', 'local-passed'),
    '',
    '## 4. 集成日志（历史证据，只追加，最新在上）',
    '',
    '- 2026-10-14：新条目。',
    '',
    '- 2026-09-01：旧条目。',
    '',
    '## 6. 平台待验清单',
    '',
    '| 平台 | 行数 | 任务 ID |',
    '|---|---:|---|',
    '| Android | 1 | T1.2 |',
    '',
  ].join('\n');
}

function runArchive(dir, extraArgs = []) {
  const tasks = path.join(dir, 'TASKS.md');
  const archive = path.join(dir, 'TASKS-archive.md');
  execFileSync('node', [SCRIPT, '--tasks', tasks, '--archive', archive, ...extraArgs], { stdio: 'pipe' });
  return { tasks: fs.readFileSync(tasks, 'utf8'), archive: fs.readFileSync(archive, 'utf8') };
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-tasks-'));
  fs.writeFileSync(path.join(dir, 'TASKS.md'), fixture());
  return dir;
}

test('moves done rows, listed pending rows, released claims and dated log bullets', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'pending.txt'), 'T1.2\n');
  fs.writeFileSync(path.join(dir, 'release.txt'), '# 分支已删除\nT1.4\n');
  const { tasks, archive } = runArchive(dir, [
    '--before', '2026-10-01',
    '--pending-ids', path.join(dir, 'pending.txt'),
    '--release-claims', path.join(dir, 'release.txt'),
  ]);

  for (const id of ['T1.1', 'T1.2']) {
    assert.ok(!tasks.includes(`| ${id} | 任务`), `${id} row should leave TASKS`);
    assert.ok(archive.includes(`| ${id} | 任务`), `${id} row should be archived`);
  }
  assert.ok(tasks.includes('| T1.3 | 任务'), 'in-progress row stays');
  // T1.3 仍是 [~]，认领保留；T1.5 未合入也未列入释放清单，认领保留。
  assert.ok(tasks.includes('| T1.3 | a |'));
  assert.ok(tasks.includes('| T1.5 | a |'));
  for (const id of ['T1.1', 'T1.2', 'T1.4']) {
    assert.ok(!tasks.includes(`| ${id} | a |`), `${id} claim should be released`);
    assert.ok(archive.includes(`| ${id} | a |`));
  }
  assert.ok(tasks.includes('### 2.1 Remote Handoff Readiness') && tasks.includes('| `main` | `abc` |'),
    '§2.1 must not be treated as claims');
  assert.ok(tasks.includes('- 2026-10-14：新条目。'));
  assert.ok(!tasks.includes('旧条目'));
  assert.match(archive, /### 2026-09-01\n\n- 2026-09-01：旧条目。/u);
});

test('rejects a pending id that is not a pushed [v] row', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'pending.txt'), 'T1.3\n');
  assert.throws(() => runArchive(dir, ['--pending-ids', path.join(dir, 'pending.txt')]));
});

test('is idempotent', () => {
  const dir = tempDir();
  const first = runArchive(dir, ['--before', '2026-10-01']);
  const second = runArchive(dir, ['--before', '2026-10-01']);
  assert.equal(second.tasks, first.tasks);
  assert.equal(second.archive, first.archive);
});

test('rejects a pending id missing from the §6 platform index', () => {
  const dir = tempDir();
  const tasks = path.join(dir, 'TASKS.md');
  fs.writeFileSync(tasks, fs.readFileSync(tasks, 'utf8').replace('| Android | 1 | T1.2 |', '| Android | 0 | — |'));
  fs.writeFileSync(path.join(dir, 'pending.txt'), 'T1.2\n');
  assert.throws(() => runArchive(dir, ['--pending-ids', path.join(dir, 'pending.txt')]), /§6/u);
});

test('keeps each archived table separator and fixes widths that do not match the header', () => {
  const dir = tempDir();
  const archive = path.join(dir, 'TASKS-archive.md');
  fs.writeFileSync(archive, [
    '# 归档', '', '## 2. 活跃认领', '', '## 3. 任务表', '',
    '### M1 示例', '', TASK_HEADER, '|---|---|:---:|---|---|---|---|---|', taskRow('T1.8', '[x]', 'merged-remote', 'complete'), '',
    '### M2 示例', '', TASK_HEADER, '|---|---|---|---|---|---|---|---|---|', taskRow('T2.8', '[x]', 'merged-remote', 'complete'), '',
    '## 4. 集成日志（历史证据，只追加，最新在上）', '',
  ].join('\n'));
  const { archive: out } = runArchive(dir);
  assert.match(out, /### M1 示例\n\n\| ID [^\n]+\n\|---\|---\|:---:\|---\|---\|---\|---\|---\|\n/u);
  assert.ok(out.includes(`### M2 示例\n\n${TASK_HEADER}\n${TASK_SEP}\n`));
});

test('dated bullets inside an archived heading block stay in that block', () => {
  const dir = tempDir();
  const archive = path.join(dir, 'TASKS-archive.md');
  fs.writeFileSync(archive, [
    '# 归档', '', '## 2. 活跃认领', '', '## 3. 任务表', '',
    '## 4. 集成日志（历史证据，只追加，最新在上）', '',
    '### 2026-08-02', '', '- 2026-08-02：甲。', '', '### 2026-08-01', '', '- 2026-08-01：乙。', '',
  ].join('\n'));
  const { archive: out } = runArchive(dir, ['--before', '2026-10-01']);
  assert.equal(out.match(/^### 2026-08-02$/gmu).length, 1);
  assert.equal(out.match(/^### 2026-08-01$/gmu).length, 1);
  assert.equal(out.match(/^- 2026-08-02：甲。$/gmu).length, 1);
});
