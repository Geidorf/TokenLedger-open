// scripts/branch-audit.test.mjs 的定点夹具：一个内容可预测的临时 git 仓库，用来把
// docs/runbooks/branch-hygiene.md §1/§2 的每一格判据各钉一条分支。
//
// 它同时是 JEID-68 的证据工具：`node scripts/fixtures/branch-audit-demo.mjs <dir>` 会在
// <dir> 建出同一套夹具，于是「现场无某档」时可以用夹具输出补齐（DoD 第 3 条），
// 而补齐用的仓库与测试用的是同一个构造函数，不会出现「证据与测试不是同一件事」。
//
// 夹具仓库没有远端：A2 的 open PR head 集合由 buildDemoRepo 写出的 JSON 提供
// （对应真实场景里的 `git ls-remote origin 'refs/pull/*/head'`）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 判定基准时刻：夹具里所有「旧」提交都在 T-14 之前（进 B 档），一条恰好落在观察区
// [T-14, T-7)，一条在 T-7 之内（A4 直接排除）。
export const FIXTURE_NOW = '2026-09-18T00:00:00.000Z';
export const FIXTURE_COOLDOWN_DAYS = 14;

const OLD = (day, hour = 0) => `2026-06-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
// 观察区样本：距 FIXTURE_NOW 10 天，落在 [T-14, T-7)。
const OBSERVE = '2026-09-08T00:00:00.000Z';
// A4 排除样本：距 FIXTURE_NOW 3 天，在 T-7 之内。
const RECENT = '2026-09-15T00:00:00.000Z';

const TASKS_FIXTURE = [
  '# 夹具台账（仅供 scripts/branch-audit.test.mjs 使用，与真实台账无关）',
  '',
  '## 2. 活跃认领',
  '',
  '| 任务 | Owner | Machine / workspace | Base | Branch | 路径所有权 | 共享资源 | Integration | Validation | 认领时间 | Handoff |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  '| T90.2 | fixture | fixture-machine | `0000000000000000000000000000000000000000` | `fixture/claimed-branch` | fixture/** | [] | committed | not-run | 2026-06-01 | false |',
  '',
  '## 3. 任务表',
  '',
  '### M9 夹具',
  '',
  '| ID | 任务 | 依赖 | 关联 | 状态 | Integration | Validation | 验收 / 当前缺口 |',
  '|---|---|---|---|---|---|---|---|',
  '| T90.1 | 已终结的夹具任务（B2 的挂账对象） | — | — | [x] | merged-local | complete | fixture |',
  '| T90.2 | 在途的夹具任务（应被 A3 排除） | — | — | [~] | committed | local-passed | fixture |',
  '',
].join('\n');

function git(args, cwd, date) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'branch-audit-fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'branch-audit-fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) {
    throw new Error(`夹具 git ${args.join(' ')} 失败：${(result.stderr || result.error?.message || '').trim()}`);
  }
  return (result.stdout ?? '').trim();
}

// 夹具自建标记：写在 <repo>/.git/ 下，既不进工作区（不脏化 git status），又能把
// 「夹具上一次建出来的目录」与「调用方误传的普通目录」区分开。
export const FIXTURE_MARKER = 'branch-audit-fixture-marker';

// 误删护栏：目标目录不存在、为空、或带夹具标记时才允许被 rmSync 重建；
// 其余情形（非空且非夹具自建）一律拒绝，除非调用方显式 force。
export function assertReplaceableFixtureDir(root, { force = false } = {}) {
  const repo = path.resolve(root);
  if (force) return repo;
  if (!fs.existsSync(repo)) return repo;
  if (!fs.statSync(repo).isDirectory()) {
    throw new Error(`夹具目标不是目录：${repo}`);
  }
  if (fs.readdirSync(repo).length === 0) return repo;
  if (fs.existsSync(path.join(repo, '.git', FIXTURE_MARKER))) return repo;
  throw new Error(
    `拒绝删除非空目录 ${repo}：它不是夹具自建（缺少 .git/${FIXTURE_MARKER}），`
    + '误传会清空该目录。请改用不存在的路径或空目录，或显式加 --force。',
  );
}

export function buildDemoRepo(root, options = {}) {
  const repo = assertReplaceableFixtureDir(root, options);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  git(['init', '-b', 'main'], repo, OLD(1));
  fs.writeFileSync(path.join(repo, '.git', FIXTURE_MARKER), 'branch-audit fixture\n');

  const write = (relative, text) => {
    const absolute = path.join(repo, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text);
  };
  const commit = (date, message, files) => {
    git(['add', '--', ...files], repo, date);
    git(['commit', '--quiet', '-m', message], repo, date);
  };

  // 主线：c1 → c2 → c3（main 的 tip 是 c3）
  write('docs/TASKS.md', TASKS_FIXTURE);
  write('a.txt', '1\n');
  commit(OLD(1), '夹具 c1：初始提交', ['docs/TASKS.md', 'a.txt']);
  write('b.txt', 'b\n');
  commit(OLD(2), '夹具 c2：主线第二次提交', ['b.txt']);
  write('a.txt', '1\n2\n');
  commit(OLD(3), '夹具 c3：主线修改 a.txt', ['a.txt']);

  // B1/ancestor：tip 是 main 的祖先
  git(['branch', 'fixture/merged-ancestor', 'main~1'], repo, OLD(3));

  // PR 线：P1（PR 线上超出基线的提交）→ P2（open PR head）→ P3（PR head + 未推送提交）
  git(['switch', '--quiet', '-c', 'fixture/open-pr-head', 'main~1'], repo, OLD(4));
  write('pr.txt', 'pr\n');
  commit(OLD(4), '夹具 P1：PR 线第一步', ['pr.txt']);
  git(['branch', 'fixture/tip-before-pr-head', 'HEAD'], repo, OLD(4));
  write('pr2.txt', 'pr2\n');
  commit(OLD(5), '夹具 P2：PR 线第二步（open PR head）', ['pr2.txt']);
  git(['switch', '--quiet', '-c', 'fixture/pr-head-ancestor', 'HEAD'], repo, OLD(6));
  write('pr3.txt', 'pr3\n');
  commit(OLD(6), '夹具 P3：PR head 之上的未推送提交', ['pr3.txt']);

  // B1/patch-equivalent：与 c3 相同的补丁落在 c1 上
  git(['switch', '--quiet', '-c', 'fixture/patch-equivalent', 'main~2'], repo, OLD(7));
  write('a.txt', '1\n2\n');
  commit(OLD(7), '夹具：同一个补丁落在 c1 上', ['a.txt']);

  // B1/content-equivalent：净变化为零（改一次再还原）
  git(['switch', '--quiet', '-c', 'fixture/content-equivalent', 'main'], repo, OLD(8));
  write('a.txt', '1\n2\n3\n');
  commit(OLD(8), '夹具：临时改动 a.txt', ['a.txt']);
  write('a.txt', '1\n2\n');
  commit(OLD(9), '夹具：还原临时改动', ['a.txt']);

  // B2：独有提交 + 有主（分支名带 T90.1，§3 里是 [x]）
  git(['switch', '--quiet', '-c', 'fixture/T90.1-unique-with-owner', 'main~2'], repo, OLD(10));
  write('owner.txt', 'owner\n');
  commit(OLD(10), '夹具：T90.1 的独有提交', ['owner.txt']);

  // B3：独有提交 + 无主（分支名解析不出任何任务 ID）
  git(['switch', '--quiet', '-c', 'fixture/unique-no-owner', 'main~2'], repo, OLD(11));
  write('orphan.txt', 'orphan\n');
  commit(OLD(11), '夹具：无主的独有提交', ['orphan.txt']);

  // A4：观察区样本（%(committerdate) ∈ [T-14, T-7)）——只输出、不判 B 档
  git(['switch', '--quiet', '-c', 'fixture/observe-window', 'main~2'], repo, OBSERVE);
  write('observe.txt', 'observe\n');
  commit(OBSERVE, '夹具：观察区（未满 14 天）的独有提交', ['observe.txt']);

  // A4：排除样本（%(committerdate) ≥ T-7）
  git(['switch', '--quiet', '-c', 'fixture/recent-untouched', 'main~2'], repo, RECENT);
  write('recent.txt', 'recent\n');
  commit(RECENT, '夹具：T-7 之内的提交', ['recent.txt']);

  // A3：登记在 §2 Active Claims
  git(['switch', '--quiet', '-c', 'fixture/claimed-branch', 'main~2'], repo, OLD(12));
  write('claimed.txt', 'claimed\n');
  commit(OLD(12), '夹具：被认领的分支', ['claimed.txt']);

  // A3/A5：§3 在途任务的分支
  git(['switch', '--quiet', '-c', 'fixture/T90.2-active-owner', 'main~2'], repo, OLD(13));
  write('active.txt', 'active\n');
  commit(OLD(13), '夹具：在途任务的分支', ['active.txt']);

  // X1：发布线
  git(['switch', '--quiet', '-c', 'release/fixture-line', 'main~2'], repo, OLD(14));
  write('release.txt', 'release\n');
  commit(OLD(14), '夹具：发布线分支', ['release.txt']);

  git(['switch', '--quiet', 'main'], repo, OLD(14));

  const prHeadSha = git(['rev-parse', 'fixture/open-pr-head'], repo, OLD(14));
  const prHeadsJson = path.join(path.dirname(repo), `${path.basename(repo)}.pr-heads.json`);
  fs.writeFileSync(prHeadsJson, `${JSON.stringify({ shas: [prHeadSha] }, null, 2)}\n`);

  return { repo, prHeadsJson, prHeadSha, now: FIXTURE_NOW, tasks: 'docs/TASKS.md' };
}

function main(argv) {
  const rest = argv.filter((arg) => arg !== '--force');
  const force = rest.length !== argv.length;
  const target = rest[0];
  if (!target || rest.length > 1) {
    console.error('用法: node scripts/fixtures/branch-audit-demo.mjs <dir> [--force]');
    return 1;
  }
  let built;
  try {
    built = buildDemoRepo(target, { force });
  } catch (error) {
    console.error(`夹具构建失败：${error.message}`);
    return 1;
  }
  console.log(`夹具仓库: ${built.repo}`);
  console.log(`open PR head 集合: ${built.prHeadsJson}（${built.prHeadSha}）`);
  console.log(`建议命令: node scripts/branch-audit.mjs --repo ${built.repo} --base main `
    + `--cooldown-days 14 --now ${built.now} --pr-heads-json ${built.prHeadsJson} --no-fetch`);
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url && import.meta.url.endsWith('branch-audit-demo.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
