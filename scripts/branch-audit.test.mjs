// scripts/branch-audit.mjs 的契约测试（JEID-68 DoD 第 2 条）。
//
// 覆盖四件事：
//   1. 判据本身：A1–A5 与 B1–B3 每一格都在夹具里各有一条分支钉住，改动判据必然让某条断言转红；
//   2. 只读红线：源码文本断言（不存在删除/改写 ref 的子命令）+ 运行前后 ref 快照（仓库没被动过）；
//   3. 台账一致性：runbook 与脚本对 A1–A5 / B1–B3 / G1–G5 的措辞逐字相同（DoD 第 5 条）；
//   4. --base 归一化与 fetch/prune 默认行为（T10.157，评审 P2）：非默认基线（如
//      origin/develop）自身不得被判成候选；默认 fetch 不得修剪本地 remote-tracking ref。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AUDIT_RULES,
  B_VERDICTS,
  CANDIDACY_GATES,
  CANDIDATE_VERDICTS,
  CLASSIFY_ONLY_CHECKS,
  DEFAULT_COOLDOWN_DAYS,
  EXIT_CODES,
  HUMAN_GATES,
  OBSERVE_MIN_DAYS,
  OBSERVE_VERDICT,
  branchNameOf,
  buildPlan,
  displayNameOf,
  normalizeIssues,
  parseArgs,
  taskOwnerOf,
} from './branch-audit.mjs';
import { FIXTURE_COOLDOWN_DAYS, FIXTURE_MARKER, FIXTURE_NOW, buildDemoRepo } from './fixtures/branch-audit-demo.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPTS_DIR, '..');
const SCRIPT = path.join(SCRIPTS_DIR, 'branch-audit.mjs');
const FIXTURE_CLI = path.join(SCRIPTS_DIR, 'fixtures', 'branch-audit-demo.mjs');
const TEST_FILE = fileURLToPath(import.meta.url);
const RUNBOOK = path.join(ROOT, 'docs', 'runbooks', 'branch-hygiene.md');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-audit-'));
  return buildDemoRepo(path.join(dir, 'repo'));
}

function planOf(built, overrides = {}) {
  return buildPlan({
    repo: built.repo,
    base: 'main',
    now: FIXTURE_NOW,
    cooldownDays: FIXTURE_COOLDOWN_DAYS,
    tasks: built.tasks,
    prHeadsJson: built.prHeadsJson,
    noFetch: true,
    offline: true,
    ...overrides,
  });
}

function gitOut(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} 失败：${result.stderr}`);
  return result.stdout;
}

function verdictsOf(plan, verdict) {
  return plan.candidates.filter((entry) => entry.verdict === verdict);
}

function excludedOf(plan, rule) {
  return plan.excluded.filter((entry) => entry.rule_hit === rule);
}

// ---------------------------------------------------------------- 判据
test('夹具把 B1 的三条判据分别钉住，且不会互相顶替', () => {
  const built = fixture();
  const plan = planOf(built);
  assert.equal(plan.exit_code, EXIT_CODES.ok);
  assert.equal(plan.counts.candidates, 6);
  assert.equal(plan.counts.B1, 3);
  assert.equal(plan.counts.B2, 1);
  assert.equal(plan.counts.B3, 1);
  assert.equal(plan.counts.observe, 1);
  assert.deepEqual(
    verdictsOf(plan, 'B1').map((entry) => entry.rule_hit).sort(),
    ['ancestor', 'content-equivalent', 'patch-equivalent'],
  );
  // patch 等价与内容等价的分支都不是 base 的祖先，三者互不重叠
  const patch = verdictsOf(plan, 'B1').find((entry) => entry.rule_hit === 'patch-equivalent');
  assert.equal(patch.branch, 'fixture/patch-equivalent');
  assert.equal(patch.ahead_commits, 0);
  const content = verdictsOf(plan, 'B1').find((entry) => entry.rule_hit === 'content-equivalent');
  assert.equal(content.branch, 'fixture/content-equivalent');
  for (const entry of verdictsOf(plan, 'B1')) {
    assert.equal(entry.action, 'delete-only-after-G3-literal-owner-approval');
    assert.ok(entry.commands.length >= 1, `${entry.branch} 必须留下所用命令原文`);
  }
});

test('观察区（%(committerdate) ∈ [T-14, T-7)）只输出、不判 B 档，不得混进 B1/B2/B3', () => {
  const built = fixture();
  const plan = planOf(built);
  const observed = plan.candidates.filter((entry) => entry.verdict === OBSERVE_VERDICT.code);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].branch, 'fixture/observe-window');
  assert.equal(observed[0].rule_hit, 'observe-window');
  assert.equal(observed[0].action, OBSERVE_VERDICT.action);
  // 同一格不得同时出现在 B1/B2/B3
  for (const verdict of ['B1', 'B2', 'B3']) {
    assert.ok(
      !plan.candidates.some((entry) => entry.branch === 'fixture/observe-window' && entry.verdict === verdict),
      `观察区条目不得混进 ${verdict}`,
    );
  }
  assert.equal(plan.counts.B1 + plan.counts.B2 + plan.counts.B3, 5);
  assert.equal(plan.counts.candidates, plan.counts.B1 + plan.counts.B2 + plan.counts.B3 + plan.counts.observe);
  // A1–A5/X1 判定与命令原文保留（只输出，不是不输出）
  assert.ok(observed[0].command.includes("git for-each-ref --format='%(committerdate:iso-strict)'"));
  assert.ok(observed[0].checks.A1.pass && observed[0].checks.A4.pass && observed[0].checks.A5.pass);
  assert.ok(observed[0].checks.A4.detail.includes('观察区'));
  assert.equal(observed[0].ahead_commits, null, '观察区不做 B 档归类，不产出 ahead_commits');
  // 两道门槛与观察区窗口写进 plan 头部，供复算
  assert.equal(plan.cooldown_days, 14);
  assert.deepEqual(plan.observe_window.days, [OBSERVE_MIN_DAYS, DEFAULT_COOLDOWN_DAYS]);
  assert.ok(plan.observe_window.rule.includes('只输出'));
  assert.ok(plan.notes.some((note) => note.includes('observe')));
});

test('冷却天数 ≤ 7 时观察区为空，老候选直接进 B 档', () => {
  const built = fixture();
  const plan = planOf(built, { cooldownDays: OBSERVE_MIN_DAYS });
  assert.equal(plan.counts.observe, 0);
  assert.deepEqual(plan.observe_window.days, [OBSERVE_MIN_DAYS, OBSERVE_MIN_DAYS]);
  assert.equal(verdictsOf(plan, 'B3').length, 2);
});

test('观察区边界以实现为准：committerdate 恰等于 T-cooldown 时判 observe，恰等于 T-7 时不进候选', () => {
  const built = fixture();
  // 夹具里 observe 样本的 committerdate = 2026-09-08、recent 样本 = 2026-09-15；
  // 取 --now = 2026-09-22 时 T-cooldown(14) = 2026-09-08、T-7 = 2026-09-15，两个样本各自压在边界上。
  const plan = planOf(built, { now: '2026-09-22T00:00:00.000Z' });
  assert.equal(plan.b_cutoff, '2026-09-08T00:00:00.000Z');
  assert.equal(plan.cutoff, '2026-09-15T00:00:00.000Z');

  const lower = plan.candidates.find((entry) => entry.branch === 'fixture/observe-window');
  assert.ok(lower, 'committerdate 恰等于 T-cooldown 的 ref 必须留在候选清单里（观察区左端闭）');
  assert.equal(lower.verdict, OBSERVE_VERDICT.code);
  assert.equal(lower.rule_hit, 'observe-window');
  assert.ok(
    !['B1', 'B2', 'B3'].includes(lower.verdict),
    '观察区左端点不得被判成 B 档——否则 pool 里就少了一条「只看不动」的可见证据',
  );

  assert.ok(
    excludedOf(plan, 'A4').some((entry) => entry.branch === 'fixture/recent-untouched'),
    'committerdate 恰等于 T-7 的 ref 不进候选（观察区右端开）',
  );
});

test('plan 记录快照时刻与 ref 快照 digest，digest 随 ref 集合变化', () => {
  const built = fixture();
  const first = planOf(built);
  const second = planOf(built);
  assert.equal(first.snapshot.taken_at, FIXTURE_NOW, '快照时刻必须与判定用的 now 一致');
  assert.equal(first.snapshot.digest_algorithm, 'sha256');
  assert.match(first.snapshot.digest, /^[0-9a-f]{64}$/u);
  assert.equal(first.snapshot.ref_count, first.evidence.ref_count);
  assert.equal(second.snapshot.digest, first.snapshot.digest, '同一份 ref 快照重跑，digest 必须相同');

  gitOut(built.repo, ['branch', 'fixture/digest-probe', 'main']);
  const third = planOf(built);
  assert.equal(third.snapshot.ref_count, first.snapshot.ref_count + 1);
  assert.notEqual(third.snapshot.digest, first.snapshot.digest, 'ref 集合变化必须反映到 digest（pool 74→75 的自证手段）');
});

test('B2 与 B3 的分界是「有没有可挂账的归属」', () => {
  const built = fixture();
  const plan = planOf(built);

  const b2 = verdictsOf(plan, 'B2');
  assert.equal(b2.length, 1);
  assert.equal(b2[0].branch, 'fixture/T90.1-unique-with-owner');
  assert.equal(b2[0].owner_issue, 'T90.1');
  assert.equal(b2[0].owner_in_tasks_table, true);
  assert.equal(b2[0].ahead_commits, 1);
  assert.equal(b2[0].pushed, false);
  assert.equal(b2[0].action, 'record-on-owner-issue-and-hold-30d');
  assert.equal(b2[0].rule_hit, 'distinct-commits-with-owner');

  const b3 = verdictsOf(plan, 'B3');
  assert.equal(b3.length, 1);
  assert.equal(b3[0].branch, 'fixture/unique-no-owner');
  assert.equal(b3[0].owner_issue, null);
  assert.equal(b3[0].ahead_commits, 1);
  assert.equal(b3[0].action, 'list-for-claim-and-hold-7d');
  assert.equal(b3[0].rule_hit, 'distinct-commits-without-owner');
  assert.ok(b3[0].checks.A5.detail.includes('归属缺失'), 'B3 必须是「归属缺失」，不是「已终结」');
});

test('A2 的三条排除路径各自生效，且都不是候选', () => {
  const built = fixture();
  const plan = planOf(built);
  const a2 = excludedOf(plan, 'A2');
  const branches = a2.map((entry) => entry.branch).sort();
  assert.deepEqual(branches, ['fixture/open-pr-head', 'fixture/pr-head-ancestor', 'fixture/tip-before-pr-head']);

  const byBranch = new Map(a2.map((entry) => [entry.branch, entry]));
  assert.ok(byBranch.get('fixture/open-pr-head').detail.includes('tip 就是某条 open PR 的 head'));
  assert.ok(byBranch.get('fixture/pr-head-ancestor').detail.includes('是 tip 的祖先'));
  assert.ok(byBranch.get('fixture/tip-before-pr-head').detail.includes('不是基线 main 的祖先'));

  for (const entry of a2) {
    assert.ok(entry.command.startsWith('git merge-base --is-ancestor'), 'A2 的决定性证据必须是等价命令原文');
    assert.equal(entry.exit_code, 0);
    assert.ok(
      !plan.candidates.some((candidate) => candidate.ref === entry.ref),
      `${entry.name} 不能出现在候选清单里`,
    );
  }
});

test('tip 只是基线老历史时不因「在 PR 线上」被误排除', () => {
  const built = fixture();
  const plan = planOf(built);
  const candidate = plan.candidates.find((entry) => entry.branch === 'fixture/merged-ancestor');
  assert.ok(candidate, '合并过的老分支必须能走到 B1，不能被 A2 吞掉');
  assert.equal(candidate.verdict, 'B1');
  assert.equal(candidate.rule_hit, 'ancestor');
});

test('A1/A3/A4/X1 各排除一格', () => {
  const built = fixture();
  const plan = planOf(built);
  assert.deepEqual(
    excludedOf(plan, 'A1').map((entry) => entry.name),
    ['main'],
  );
  assert.deepEqual(
    excludedOf(plan, 'A3').map((entry) => entry.name).sort(),
    ['fixture/T90.2-active-owner', 'fixture/claimed-branch'],
  );
  assert.match(excludedOf(plan, 'A3').find((entry) => entry.branch === 'fixture/claimed-branch').detail, /Active Claims/u);
  assert.deepEqual(
    excludedOf(plan, 'A4').map((entry) => entry.name),
    ['fixture/recent-untouched'],
  );
  assert.deepEqual(
    excludedOf(plan, 'X1').map((entry) => entry.name),
    ['release/fixture-line'],
  );
  // A5 自 2026-09-18 对齐 D1=A 后不再是成员门禁：这条分支由 A3 挡住（rule_hit 取最先
  // 失败的门禁），但 A5 的留证标记仍为 false（归属未终结），分档时读的是它的归属。
  const active = excludedOf(plan, 'A3').find((entry) => entry.branch === 'fixture/T90.2-active-owner');
  assert.equal(active.checks.A5, false);
});

// ---------------------------------------------------------------- A1：非默认基线（T10.157）
// 独立于共享夹具另建一个只在本文件用的临时仓库：基线是 develop 不是 main，且本地与
// 远端跟踪各有一份。修复前 checkA1 只做字符串字面比较——默认 --base origin/main 之所以
// 看起来正确，只是因为 main 恰好也在 TARGET_BRANCH_NAMES 硬编码兜底里；--base 换成
// origin/develop 这种非默认写法时，基线自己（本地 develop、远端跟踪 origin/develop）
// 反而不会被排除，可能被判成删除候选。
const MINIMAL_TASKS_MD = [
  '# 夹具台账（仅供 scripts/branch-audit.test.mjs 的 T10.157 用例使用）',
  '',
  '## 2. 活跃认领',
  '',
  '| 任务 | Owner | Machine / workspace | Base | Branch | 路径所有权 | 共享资源 | Integration | Validation | 认领时间 | Handoff |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  '',
  '## 3. 任务表',
  '',
  '### M9 夹具',
  '',
  '| ID | 任务 | 依赖 | 关联 | 状态 | Integration | Validation | 验收 / 当前缺口 |',
  '|---|---|---|---|---|---|---|---|',
  '',
].join('\n');

function commitDated(repo, message, iso) {
  const result = spawnSync('git', ['commit', '-q', '-m', message], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  });
  assert.equal(result.status, 0, `git commit 失败：${result.stderr}`);
}

function buildBaseIdentityRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-audit-base-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  gitOut(repo, ['init', '-q', '-b', 'work']);
  gitOut(repo, ['config', 'user.email', 'branch-audit-fixture@example.invalid']);
  gitOut(repo, ['config', 'user.name', 'branch-audit-fixture']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'docs', 'TASKS.md'), MINIMAL_TASKS_MD);
  gitOut(repo, ['add', 'a.txt', 'docs/TASKS.md']);
  commitDated(repo, '基线提交（陈旧）', '2026-01-01T00:00:00.000Z');
  const baseSha = gitOut(repo, ['rev-parse', 'HEAD']).trim();

  // develop：与基线等价（tip = 上面这条 2026-01-01 的老提交）。本地分支存在但当前不被
  // 检出（HEAD 停在 work 上）、也早就过了冷却期——刻意模拟「陈旧、没人 checkout」的
  // 基线分支，用来证明 A1 把它挡住，不是靠 A4/A3 侥幸挡住。
  gitOut(repo, ['branch', 'develop', baseSha]);
  gitOut(repo, ['update-ref', 'refs/remotes/origin/develop', baseSha]);

  // 形近但不同名：验证短名比较是精确相等，不是前缀/子串匹配。
  gitOut(repo, ['branch', 'developer', baseSha]);

  // 无关分支：真正该被清点覆盖到的候选，不该被 A1 误伤。
  gitOut(repo, ['checkout', '-q', '-b', 'feature/needs-review', 'develop']);
  fs.writeFileSync(path.join(repo, 'c.txt'), 'feature\n');
  gitOut(repo, ['add', 'c.txt']);
  gitOut(repo, ['commit', '-q', '-m', '无关分支的独有提交']);
  gitOut(repo, ['checkout', '-q', 'work']);

  return repo;
}

test('A1：非默认基线（--base origin/develop / --base develop）自身——含本地与远端跟踪、含陈旧未检出的 develop——永不进候选', () => {
  const repo = buildBaseIdentityRepo();
  for (const base of ['origin/develop', 'develop']) {
    const plan = buildPlan({
      repo,
      base,
      now: '2026-09-24T00:00:00.000Z',
      noFetch: true,
      offline: true,
    });
    assert.deepEqual(
      excludedOf(plan, 'A1').map((entry) => entry.name).sort(),
      ['develop', 'origin/develop'],
      `--base ${base} 时，develop 的本地分支与远端跟踪分支必须都被 A1 排除，`
      + '且不得误伤形近的 developer 或无关的 feature/needs-review',
    );
  }
});

test('候选门禁是 A1–A4 与 X1，A5 只参与分档（JEID-67 §0 D1=A）', () => {
  const runbook = fs.readFileSync(RUNBOOK, 'utf8');
  assert.deepEqual(CANDIDACY_GATES, ['A1', 'A2', 'A3', 'A4', 'X1']);
  assert.deepEqual(CLASSIFY_ONLY_CHECKS, ['A5']);
  assert.ok(
    AUDIT_RULES.every((rule) => CANDIDACY_GATES.includes(rule.code) || CLASSIFY_ONLY_CHECKS.includes(rule.code)),
    '每一格判据要么是门禁、要么是分档输入，不允许既不是门禁也不被引用',
  );
  assert.ok(
    AUDIT_RULES.find((rule) => rule.code === 'A5').summary.includes('只参与 B2/B3 分档，不构成成员门禁'),
    'A5 的判据原文必须写明它不再是成员门禁',
  );
  assert.ok(
    runbook.includes("CANDIDACY_GATES = ['A1','A2','A3','A4','X1']"),
    'runbook 必须写明门禁集合，且与脚本常量逐字相同',
  );

  const plan = planOf(fixture());
  assert.equal(
    plan.excluded.filter((entry) => entry.rule_hit === 'A5').length,
    0,
    'A5 不再是门禁，不得出现在 excluded[] 的 rule_hit 里',
  );
  assert.ok(plan.candidates.every((entry) => 'A5' in entry.checks), 'A5 仍逐条产出，作为分档输入与留证');
});

test('冷却期调成 0 时，冷却期内的分支立刻进入候选', () => {
  const built = fixture();
  const plan = planOf(built, { cooldownDays: 0 });
  assert.equal(excludedOf(plan, 'A4').length, 0);
  assert.ok(plan.candidates.some((entry) => entry.branch === 'fixture/recent-untouched'));
  assert.equal(plan.counts.observe, 0, 'cooldown=0 时观察区为空');
  assert.equal(plan.counts.B3, 3);
});

test('A2 证据缺失时清单不完整：候选全部抑制、退出码 2、绝不静默通过', () => {
  const built = fixture();
  const plan = planOf(built, { prHeadsJson: null, offline: true });
  assert.equal(plan.exit_code, EXIT_CODES.incomplete);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.counts.excluded_by_rule.A2, 13);
  assert.ok(plan.notes.some((note) => note.includes('A2 证据缺失')));
  assert.equal(plan.evidence.open_pr_heads.available, false);
});

test('未给 --issues-json 时 A3 明确标注只覆盖仓库侧证据', () => {
  const built = fixture();
  const plan = planOf(built);
  assert.equal(plan.evidence.issue_status.source, 'repo-only');
  assert.ok(plan.candidates.every((entry) => entry.a3_source === 'repo-only'));
  assert.ok(plan.notes.some((note) => note.includes('--issues-json')));
});

test('--issues-json 里 in_progress 的 issue 会让对应分支落进 A3', () => {
  const built = fixture();
  const plan = planOf(built, {
    issues: [{ identifier: 'T90.1', status: 'in_progress' }],
    issuesPath: 'fixture-issues.json',
  });
  assert.equal(plan.evidence.issue_status.source, 'issues-json');
  assert.ok(excludedOf(plan, 'A3').some((entry) => entry.branch === 'fixture/T90.1-unique-with-owner'));
});

test('夹具拒绝清空非空且非夹具自建的目录，除非显式 --force', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-audit-guard-'));
  const target = path.join(dir, 'not-a-fixture');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'important.txt'), 'do not delete\n');

  assert.throws(() => buildDemoRepo(target), /拒绝删除非空目录/u);
  assert.equal(fs.readFileSync(path.join(target, 'important.txt'), 'utf8'), 'do not delete\n', '拒绝后不得动目标目录');

  const refused = spawnSync(process.execPath, [FIXTURE_CLI, target], { encoding: 'utf8' });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /拒绝删除非空目录/u);
  assert.ok(fs.existsSync(path.join(target, 'important.txt')), 'CLI 被拒后目标目录必须原样保留');

  const forced = spawnSync(process.execPath, [FIXTURE_CLI, target, '--force'], { encoding: 'utf8' });
  assert.equal(forced.status, 0, forced.stderr);
  assert.ok(fs.existsSync(path.join(target, '.git', FIXTURE_MARKER)), '--force 之后才是夹具自建目录');

  // 夹具自建的目录允许幂等重建，不必再加 --force（否则「现场无某档」的补齐流程会被自己锁死）
  const again = spawnSync(process.execPath, [FIXTURE_CLI, target], { encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr);
});

// ---------------------------------------------------------------- 只读红线
test('脚本与测试里不存在删除/改写 ref 的子命令', () => {
  // 断言用的字面量必须自己拼出来：否则这份测试自己就把被禁的字符串写进了被扫描的文件。
  const forbidden = [
    ['git branch', '-D'].join(' '),
    ['push', '--delete'].join(' '),
    ['git', 'reset'].join(' '),
    ['git', 'clean'].join(' '),
    ['git', 'checkout'].join(' '),
  ];
  for (const file of [SCRIPT, TEST_FILE]) {
    const text = fs.readFileSync(file, 'utf8');
    for (const needle of forbidden) {
      assert.ok(!text.includes(needle), `${path.relative(ROOT, file)} 不应出现「${needle}」`);
    }
  }
});

test('脚本只有一个 git 包装点，且只读子命令白名单外没有别的调用', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.equal(
    text.match(/spawnSync\(/gu).length,
    1,
    '所有 git 调用必须走同一个包装点，否则只读红线无法用源码文本断言守住',
  );
  const allowed = [
    'for-each-ref', 'rev-parse', 'rev-list', 'merge-base', 'cherry', 'diff', 'worktree',
    'ls-remote', 'fetch',
  ];
  // 每个调用点的第一个参数就是子命令，且必须是字面量（否则上面「单一包装点」的断言无意义）。
  const invoked = [...text.matchAll(/git\(\[\s*'([^']+)'/gu)].map((match) => match[1]);
  assert.ok(invoked.length >= 8, `应当能扫到全部 git 调用点，实际 ${invoked.length} 个`);
  for (const subcommand of invoked) {
    assert.ok(allowed.includes(subcommand), `子命令 ${subcommand} 不在只读白名单里`);
  }
});

test('审计跑完之后仓库的 ref 与工作区逐字节没变', () => {
  const built = fixture();
  const before = {
    refs: gitOut(built.repo, ['for-each-ref', '--format=%(refname)|%(objectname)']),
    status: gitOut(built.repo, ['status', '--porcelain']),
  };
  const plan = planOf(built);
  assert.ok(plan.counts.candidates > 0, '夹具必须真的跑出候选，否则这条只读断言是空转');
  assert.deepEqual(
    gitOut(built.repo, ['for-each-ref', '--format=%(refname)|%(objectname)']),
    before.refs,
  );
  assert.equal(gitOut(built.repo, ['status', '--porcelain']), before.status);
  assert.equal(plan.readonly, true);
  assert.equal(plan.read_only_guarantee.length, 3);
});

// ---------------------------------------------------------------- fetch/prune 默认行为（T10.157）
// 用真实的本地文件路径远端（不是共享夹具、不联网、不碰本仓库）钉住：默认 fetch 不带
// --prune，因此远端已经删掉的分支，本地缓存的 remote-tracking ref 必须原样保留；只有
// 显式传 --prune 才会把它修剪掉。修复前默认就带 --prune，会在任何人看到清单之前，
// 把「远端已经没有这条分支」这条证据直接删掉。
function buildPruneRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-audit-prune-'));
  const upstream = path.join(dir, 'upstream');
  const downstream = path.join(dir, 'downstream');
  fs.mkdirSync(path.join(upstream, 'docs'), { recursive: true });
  gitOut(upstream, ['init', '-q', '-b', 'main']);
  gitOut(upstream, ['config', 'user.email', 'branch-audit-fixture@example.invalid']);
  gitOut(upstream, ['config', 'user.name', 'branch-audit-fixture']);
  fs.writeFileSync(path.join(upstream, 'a.txt'), 'main\n');
  fs.writeFileSync(path.join(upstream, 'docs', 'TASKS.md'), MINIMAL_TASKS_MD);
  gitOut(upstream, ['add', 'a.txt', 'docs/TASKS.md']);
  gitOut(upstream, ['commit', '-q', '-m', 'init']);
  gitOut(upstream, ['checkout', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(upstream, 'b.txt'), 'develop\n');
  gitOut(upstream, ['add', 'b.txt']);
  gitOut(upstream, ['commit', '-q', '-m', 'on develop']);
  gitOut(upstream, ['checkout', '-q', 'main']);

  gitOut(path.dirname(upstream), ['clone', '-q', upstream, downstream]);
  gitOut(downstream, ['config', 'user.email', 'branch-audit-fixture@example.invalid']);
  gitOut(downstream, ['config', 'user.name', 'branch-audit-fixture']);

  // 上游删掉 develop：downstream 里 refs/remotes/origin/develop 从此就是「远端已经
  // 没有这条分支」时唯一还留着的本地痕迹——这正是 fetch --prune 会删掉的那条 ref。
  gitOut(upstream, ['branch', '-D', 'develop']);

  const prHeadsJson = path.join(dir, 'pr-heads-empty.json');
  fs.writeFileSync(prHeadsJson, `${JSON.stringify({ shas: [] })}\n`);

  return { repo: downstream, prHeadsJson };
}

function remoteTrackingDevelopRef(repo) {
  return gitOut(repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/develop']).trim();
}

test('默认 fetch 不带 --prune：远端已删除分支对应的本地 remote-tracking ref 原样保留', () => {
  const { repo, prHeadsJson } = buildPruneRepo();
  assert.equal(remoteTrackingDevelopRef(repo), 'refs/remotes/origin/develop', '跑之前必须先确认这条即将失效的 ref 还在');

  const plan = buildPlan({ repo, base: 'origin/main', now: new Date().toISOString(), prHeadsJson });
  assert.equal(plan.snapshot.fetched, 'origin (fetch)', '默认应做一次不带 --prune 的 fetch');
  assert.equal(remoteTrackingDevelopRef(repo), 'refs/remotes/origin/develop', '默认不传 --prune 时，审计跑完这条 ref 必须还在');
});

test('显式 --prune 才会修剪远端已删除分支对应的本地 remote-tracking ref', () => {
  const { repo, prHeadsJson } = buildPruneRepo();
  const plan = buildPlan({ repo, base: 'origin/main', now: new Date().toISOString(), prHeadsJson, prune: true });
  assert.equal(plan.snapshot.fetched, 'origin (--prune)');
  assert.equal(remoteTrackingDevelopRef(repo), '', '显式 --prune 之后，远端已删除的 develop 对应的本地 ref 应该被修剪掉');
});

test('--offline 时 --prune 不生效：既不联网也不改 .git', () => {
  const { repo, prHeadsJson } = buildPruneRepo();
  const before = gitOut(repo, ['for-each-ref', '--format=%(refname)|%(objectname)']);
  const plan = buildPlan({
    repo, base: 'origin/main', now: new Date().toISOString(), prHeadsJson, offline: true, prune: true,
  });
  assert.equal(plan.snapshot.fetched, 'offline', '--offline 整体关闭 fetch，--prune 不能反过来打开它');
  assert.equal(gitOut(repo, ['for-each-ref', '--format=%(refname)|%(objectname)']), before, '--offline 时即使传了 --prune 也不能碰 .git');
});

test('CLI：--no-fetch 时即使加了 --prune 也不会触发 fetch', () => {
  const built = fixture();
  const result = spawnSync(process.execPath, [
    SCRIPT, '--repo', built.repo, '--base', 'main', '--now', built.now,
    '--pr-heads-json', built.prHeadsJson, '--no-fetch', '--prune',
  ], { encoding: 'utf8' });
  assert.equal(result.status, EXIT_CODES.ok, result.stderr);
  assert.equal(JSON.parse(result.stdout).snapshot.fetched, 'skipped');
});

// ---------------------------------------------------------------- read_only_guarantee / fetch 失败提示（独立评审 P1/P2）
// 复核发现这两处文本在改成「默认不 prune」之后没跟着改：read_only_guarantee 永远印着
// 旧的「唯一写 .git 的动作是 git fetch --prune origin」，fetch 失败提示也永远写死
// --prune，即使这次根本没传。两处都改成从同一个 context.fetchCommand 派生。

test('read_only_guarantee 的措辞如实反映本次是否显式 --prune，不是永远印同一句话（独立评审 P1）', () => {
  const built = fixture();

  const withoutPrune = planOf(built);
  assert.equal(withoutPrune.read_only_guarantee.length, 3);
  assert.equal(
    withoutPrune.read_only_guarantee[1],
    '唯一写 .git 的动作是 git fetch origin（--no-fetch/--offline 关闭）；本次未传 --prune，不会修剪，只更新/新增 remote-tracking ref',
  );
  assert.ok(!withoutPrune.read_only_guarantee[1].includes('--prune origin'), '默认模式的措辞不该出现 --prune 版本的命令原文');

  const withPrune = planOf(built, { prune: true });
  assert.equal(withPrune.read_only_guarantee.length, 3);
  assert.equal(
    withPrune.read_only_guarantee[1],
    '唯一写 .git 的动作是 git fetch --prune origin（--no-fetch/--offline 关闭）；本次显式传了 --prune，会修剪远端已删除分支对应的本地 remote-tracking ref',
  );
});

function buildBrokenOriginRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-audit-brokenorigin-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  gitOut(repo, ['init', '-q', '-b', 'main']);
  gitOut(repo, ['config', 'user.email', 'branch-audit-fixture@example.invalid']);
  gitOut(repo, ['config', 'user.name', 'branch-audit-fixture']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'main\n');
  fs.writeFileSync(path.join(repo, 'docs', 'TASKS.md'), MINIMAL_TASKS_MD);
  gitOut(repo, ['add', 'a.txt', 'docs/TASKS.md']);
  gitOut(repo, ['commit', '-q', '-m', 'init']);
  // origin 指向一个必然不存在的本地路径：不联网也能确定性地让 fetch 失败（exit 128）。
  gitOut(repo, ['remote', 'add', 'origin', path.join(dir, 'this-path-does-not-exist')]);

  const prHeadsJson = path.join(dir, 'pr-heads-empty.json');
  fs.writeFileSync(prHeadsJson, `${JSON.stringify({ shas: [] })}\n`);

  return { repo, prHeadsJson };
}

test('fetch 失败提示要点名本次实际执行的命令，不是永远写死 --prune（独立评审 P2）', () => {
  const findFetchFailureNote = (plan) => plan.notes.find((note) => note.includes('失败，按现有 remote-tracking ref 清点'));

  const defaultCase = buildBrokenOriginRepo();
  const planDefault = buildPlan({
    repo: defaultCase.repo, base: 'main', now: new Date().toISOString(), prHeadsJson: defaultCase.prHeadsJson,
  });
  assert.equal(planDefault.snapshot.fetched, 'failed');
  const noteDefault = findFetchFailureNote(planDefault);
  assert.ok(noteDefault, '默认模式下 fetch 失败必须留下提示');
  assert.ok(noteDefault.startsWith('git fetch origin 失败'), `提示应点名实际执行的 git fetch origin，实际是：${noteDefault}`);
  assert.ok(!noteDefault.includes('--prune'), '默认模式没有传 --prune，提示里不该出现 --prune 字样');

  const pruneCase = buildBrokenOriginRepo();
  const planPrune = buildPlan({
    repo: pruneCase.repo, base: 'main', now: new Date().toISOString(), prHeadsJson: pruneCase.prHeadsJson, prune: true,
  });
  assert.equal(planPrune.snapshot.fetched, 'failed');
  const notePrune = findFetchFailureNote(planPrune);
  assert.ok(notePrune, '显式 --prune 模式下 fetch 失败也必须留下提示');
  assert.ok(notePrune.startsWith('git fetch --prune origin 失败'), `提示应点名实际执行的 git fetch --prune origin，实际是：${notePrune}`);
});

// ---------------------------------------------------------------- runbook 一致性
test('runbook 与脚本对 A1–A5 / B1–B3 / G1–G5 的表述逐条一致', () => {
  assert.ok(fs.existsSync(RUNBOOK), 'docs/runbooks/branch-hygiene.md 必须存在');
  const runbook = fs.readFileSync(RUNBOOK, 'utf8');
  for (const rule of [...AUDIT_RULES, ...B_VERDICTS, OBSERVE_VERDICT, ...HUMAN_GATES]) {
    assert.ok(runbook.includes(rule.summary), `${rule.code} 的判据原文没有逐字出现在 runbook 里：${rule.summary}`);
  }
  assert.equal(AUDIT_RULES.length, 6, 'A1–A5 之外还有 §0 排除集的 X1');
  assert.equal(B_VERDICTS.length, 3);
  assert.equal(HUMAN_GATES.length, 5);
});

test('runbook 记录了修订后的参数（14 天 / 观察区 / 每周一触发 / §2.1 交付 SLA）', () => {
  const runbook = fs.readFileSync(RUNBOOK, 'utf8');
  assert.equal(DEFAULT_COOLDOWN_DAYS, 14, '冷却默认值必须是 14 天');
  assert.equal(OBSERVE_MIN_DAYS, 7);
  assert.ok(runbook.includes('--cooldown-days 14'), '命令块里的冷却默认值必须是 14');
  assert.ok(runbook.includes('--cooldown'), '别名 --cooldown 必须在 runbook 里写明');
  assert.ok(runbook.includes('每周一 10:00（Asia/Shanghai）'), '触发频率必须是每周一 10:00（Asia/Shanghai）');
  assert.ok(runbook.includes('## 2.1 交付 SLA'), 'runbook 必须有 §2.1 交付 SLA');
  assert.ok(
    runbook.includes('24 小时内进 PR') && runbook.includes('48 小时内进 main'),
    'SLA 的两段时间必须逐字在 runbook 里',
  );
  assert.ok(runbook.includes('上周清点 issue 未闭环则不开新单'), '去重规则必须进 runbook');
  assert.ok(runbook.includes('无新增候选则静默结束'), '静默规则必须进 runbook');
  assert.ok(runbook.includes('空候选直接置 `done`'), '空候选规则必须进 runbook');
  for (const verdict of CANDIDATE_VERDICTS) {
    assert.ok(runbook.includes(verdict), `runbook 未说明 verdict 取值 ${verdict}`);
  }
});

test('runbook 已对齐源 JEID-67 rev 50：内容指纹 / 触发位 / 48 小时触发 / A5 平台通道 / G3 分批审批 / 区间写法', () => {
  const runbook = fs.readFileSync(RUNBOOK, 'utf8');
  assert.ok(
    runbook.includes('内容指纹 `sha256 = 107638c4cf419d9da9b2c5004e000ccee17e3ca645f7ebb47fdf686cc56b819e`'),
    '抬头必须钉住源正文的内容指纹（正文的引用口径：钉 sha256(description)、不钉 revision）',
  );
  assert.ok(
    runbook.includes('对齐记录（2026-09-18，源 rev 50）'),
    '抬头必须写明本轮对齐的两处：D1=A（候选资格 = A1–A4、A5 只分档）与 A2 的 N5 限定',
  );
  assert.ok(runbook.includes('main 连续 48 小时无提交'), '事件触发必须含「main 连续 48 小时无提交」');
  assert.ok(
    runbook.includes('触发位') && runbook.includes('自动化触发器'),
    'RACI 必须有触发位，不能只留兜底开单',
  );
  assert.ok(runbook.includes('平台 issue 为 done/cancelled'), 'A5 常量文字必须含平台通道');
  const g3 = HUMAN_GATES.find((gate) => gate.code === 'G3').summary;
  assert.ok(g3.includes('分批审批'), '脚本 G3 文本必须补「分批审批」（维护规则：Gate 变更两边同时改）');
  assert.ok(runbook.includes(g3), 'G3 措辞必须逐字进 runbook');
  assert.ok(
    runbook.includes('[T-cooldown, T-7)') && runbook.includes('恰等于 T-cooldown 时判 observe'),
    '观察区区间写法与边界说明必须与实现逐字一致',
  );
  assert.ok(runbook.includes('有意偏离'), '两处有意偏离必须显式写明，否则「照抄即可」失效');
  assert.ok(runbook.includes('快照时刻') && runbook.includes('digest'), '§7 必须要求记录快照时刻与 digest');
});

test('runbook 与脚本的判据编号没有重复也没有缺号', () => {
  assert.deepEqual(AUDIT_RULES.map((rule) => rule.code), ['A1', 'A2', 'A3', 'A4', 'A5', 'X1']);
  assert.deepEqual(B_VERDICTS.map((rule) => rule.code), ['B1', 'B2', 'B3']);
  assert.deepEqual(HUMAN_GATES.map((rule) => rule.code), ['G1', 'G2', 'G3', 'G4', 'G5']);
  assert.deepEqual(CANDIDATE_VERDICTS, ['B1', 'B2', 'B3', 'observe'], 'observe 是候选清单里的第四种取值，但不是第四档 B');
});

// ---------------------------------------------------------------- 单元
test('ref 名与分支名的互转', () => {
  assert.equal(branchNameOf('refs/heads/codex/T10.23-x'), 'codex/T10.23-x');
  assert.equal(branchNameOf('refs/remotes/origin/codex/T10.23-x'), 'codex/T10.23-x');
  assert.equal(displayNameOf('refs/heads/codex/T10.23-x'), 'codex/T10.23-x');
  assert.equal(displayNameOf('refs/remotes/origin/codex/T10.23-x'), 'origin/codex/T10.23-x');
});

test('分支名解析任务归属：T 号优先，其次 JEID 号，都没有则无主', () => {
  assert.deepEqual(taskOwnerOf('codex/T10.23-reasonix-third-party'), { id: 'T10.23', kind: 'tasks' });
  assert.deepEqual(taskOwnerOf('origin/codex/T5.3-windows-installer-refresh'), { id: 'T5.3', kind: 'tasks' });
  assert.deepEqual(taskOwnerOf('agent/agent/jeid-55'), { id: 'JEID-55', kind: 'issue' });
  assert.equal(taskOwnerOf('agent/mika/9eedaea5fc0c'), null);
  assert.equal(taskOwnerOf('codex/turn-diffs/checkpoints/abc'), null);
});

test('--issues-json 接受三种常见形态', () => {
  assert.equal(normalizeIssues([{ identifier: 'JEID-55', status: 'in_review' }]).statuses.get('JEID-55'), 'in_review');
  assert.equal(normalizeIssues({ issues: [{ id: 'jeid-61', status: 'done' }] }).statuses.get('JEID-61'), 'done');
  assert.equal(normalizeIssues({ 'JEID-64': 'in_progress' }).statuses.get('JEID-64'), 'in_progress');
  assert.throws(() => normalizeIssues(42), /无法识别/u);
});

test('参数解析：默认值、--cooldown 别名、非法取值与未知参数', () => {
  assert.equal(parseArgs([]).cooldownDays, DEFAULT_COOLDOWN_DAYS);
  assert.equal(DEFAULT_COOLDOWN_DAYS, 14);
  assert.equal(parseArgs(['--cooldown-days', '14']).cooldownDays, 14);
  assert.equal(parseArgs(['--cooldown', '14']).cooldownDays, 14, '--cooldown 是 --cooldown-days 的同义别名');
  assert.equal(parseArgs(['--cooldown', '0']).cooldownDays, 0);
  assert.equal(parseArgs([]).base, 'origin/main');
  assert.throws(() => parseArgs(['--cooldown-days', 'x']), /非负数/u);
  assert.throws(() => parseArgs(['--cooldown', 'x']), /非负数/u);
  assert.throws(() => parseArgs(['--cooldown']), /需要/u);
  assert.throws(() => parseArgs(['--nope']), /未知参数/u);
  assert.throws(() => parseArgs(['--repo']), /需要/u);
  assert.equal(parseArgs(['--offline']).noFetch, true);
  assert.equal(parseArgs([]).prune, undefined, '默认不传 --prune 时不应该被当成已请求 prune');
  assert.equal(parseArgs(['--prune']).prune, true);
  assert.equal(parseArgs(['--offline', '--prune']).noFetch, true, '--offline 仍然整体关闭 fetch，--prune 不改变这一点');
});

// ---------------------------------------------------------------- CLI
test('CLI：退出码、--out 落盘与 stdout 是同一份 JSON', () => {
  const built = fixture();
  const outFile = path.join(path.dirname(built.repo), 'cleanup-plan.json');
  const result = spawnSync(process.execPath, [
    SCRIPT,
    '--repo', built.repo,
    '--base', 'main',
    '--now', built.now,
    '--pr-heads-json', built.prHeadsJson,
    '--no-fetch',
    '--out', outFile,
  ], { encoding: 'utf8' });

  assert.equal(result.status, EXIT_CODES.ok, result.stderr);
  const stdoutPlan = JSON.parse(result.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(outFile, 'utf8')), stdoutPlan);
  assert.equal(stdoutPlan.schema, 'branch-cleanup-plan/v1');
  assert.equal(stdoutPlan.counts.B2, 1);
  assert.equal(gitOut(built.repo, ['status', '--porcelain']), '', '--out 写在仓库外，不得脏化被审计的仓库');
});

test('CLI：A2 证据缺失时以退出码 2 收尾，不是 0', () => {
  const built = fixture();
  const result = spawnSync(process.execPath, [
    SCRIPT, '--repo', built.repo, '--base', 'main', '--now', built.now, '--offline',
  ], { encoding: 'utf8' });
  assert.equal(result.status, EXIT_CODES.incomplete);
  assert.equal(JSON.parse(result.stdout).candidates.length, 0);
});

test('CLI：--help 与致命参数各自有稳定退出码', () => {
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, EXIT_CODES.ok);
  assert.match(help.stdout, /只读/u);

  const bad = spawnSync(process.execPath, [SCRIPT, '--repo', os.tmpdir(), '--now', 'x'], { encoding: 'utf8' });
  assert.equal(bad.status, EXIT_CODES.fatal);
  assert.match(bad.stderr, /审计失败|参数错误/u);

  const badFlag = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' });
  assert.equal(badFlag.status, EXIT_CODES.fatal);
});

test('package.json 暴露 branch:audit，且不接入构建门禁', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['branch:audit'], 'node scripts/branch-audit.mjs --out cleanup-plan.json');
  assert.ok(!String(pkg.scripts.check).includes('branch:audit'), '审计不参与构建判定');
});
