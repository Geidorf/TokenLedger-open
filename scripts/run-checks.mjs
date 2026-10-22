import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const git = process.platform === 'win32' ? 'git.exe' : 'git';

function trackedFiles() {
  return execFileSync(git, ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

function fingerprint(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    return 'missing';
  }

  const stat = fs.lstatSync(absolutePath);
  const mode = (stat.mode & 0o777).toString(8);
  const content = stat.isSymbolicLink()
    ? Buffer.from(fs.readlinkSync(absolutePath))
    : fs.readFileSync(absolutePath);
  const digest = createHash('sha256').update(content).digest('hex');
  return `${mode}:${stat.isSymbolicLink() ? 'link' : 'file'}:${digest}`;
}

function snapshot() {
  return new Map(trackedFiles().map((file) => [file, fingerprint(file)]));
}

function changedTrackedFiles(before, after) {
  const files = new Set([...before.keys(), ...after.keys()]);
  return [...files].filter((file) => before.get(file) !== after.get(file)).sort();
}

// Supabase 本地容器名前缀，与 supabase/README.md「本地验证」章节保持一致
// （docker exec -i supabase_db_tokenledger psql ...）。
const SUPABASE_CONTAINER_PREFIX = 'supabase_db_';

// 仅收录 supabase/README.md「本地验证」实际执行的回归文件：
// - stats_v2_regression.sql：文件内自带 `\set ON_ERROR_STOP on`，无需额外 -v fixture。
// - custom_date_range_regression.sql：同样自带 ON_ERROR_STOP，无需 fixture。它覆盖
//   custom 起止边界、DST、跨年以及 T10.119 新增的 dailyCosts 当地日键与可信空集。
//   该文件随 dailyCosts 一起进仓库，却一直只在 README 里写「需单独执行」，等于
//   contracts/dashboard-stats-v2.md 的新扩展没有任何自动门禁把关——本轮接进来。
// - quota_snapshot_v2_regression.sql：需要 -v transport_v2_fixture，取自
//   fixtures/quota-provider-v1/transport-v2.json（README 用 jq -c 压缩后传入）。
// supabase/tests/quota_snapshot_regression.sql（v6 历史语义回归）不收录：
// README 明确注明它「检测到 transport v2 时主动跳过，不作为当前数据库门禁」，
// 且不在「本地验证」命令列表内；强行把它当失败门禁与文档描述不一致。
const SUPABASE_REGRESSIONS = [
  {
    file: path.join('supabase', 'tests', 'quota_recovery_regression.sql'),
    fixtureArgs: () => {
      const fixturePath = path.join(root, 'fixtures', 'quota-provider-v1', 'transport-capacity-v1.json');
      return ['-v', `capacity_fixture=${JSON.stringify(JSON.parse(fs.readFileSync(fixturePath, 'utf8')))}`];
    },
  },
  {
    file: path.join('supabase', 'tests', 'quota_snapshot_capacity_regression.sql'),
    fixtureArgs: () => {
      const fixturePath = path.join(root, 'fixtures', 'quota-provider-v1', 'transport-capacity-v1.json');
      return ['-v', `capacity_fixture=${JSON.stringify(JSON.parse(fs.readFileSync(fixturePath, 'utf8')))}`];
    },
  },
  { file: path.join('supabase', 'tests', 'stats_v2_regression.sql') },
  { file: path.join('supabase', 'tests', 'custom_date_range_regression.sql') },
  {
    file: path.join('supabase', 'tests', 'quota_snapshot_v2_regression.sql'),
    fixtureArgs: () => {
      const fixturePath = path.join(root, 'fixtures', 'quota-provider-v1', 'transport-v2.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      return ['-v', `transport_v2_fixture=${JSON.stringify(fixture)}`];
    },
  },
  {
    file: path.join('supabase', 'tests', 'quota_snapshot_v3_regression.sql'),
    fixtureArgs: () => {
      const read = (name) => JSON.stringify(JSON.parse(
        fs.readFileSync(path.join(root, 'fixtures', 'quota-provider-v1', name), 'utf8'),
      ));
      return [
        '-v', `transport_v3_fixture=${read('transport-v3.json')}`,
        '-v', `currency_fixture=${read('currency-v1.json')}`,
      ];
    },
  },
];

export function selectSupabaseContainer(names, requested) {
  const candidates = names.filter((name) => name.startsWith(SUPABASE_CONTAINER_PREFIX));
  if (requested) {
    if (!candidates.includes(requested)) throw new Error(`指定的 SQL 测试容器未运行：${requested}`);
    return requested;
  }
  if (candidates.length > 1) {
    throw new Error('检测到多个 Supabase 数据库；请用 SUPABASE_TEST_CONTAINER 明确指定隔离测试容器。');
  }
  return candidates[0] ?? null;
}

export function detectSupabaseContainer() {
  const requested = process.env.SUPABASE_TEST_CONTAINER?.trim();
  const result = spawnSync('docker', ['ps', '--format', '{{.Names}}'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    if (requested) throw new Error('无法确认指定的 SQL 测试容器；Docker 查询失败或没有运行中的容器。');
    return null;
  }
  return selectSupabaseContainer(result.stdout.split('\n').map((name) => name.trim()), requested);
}

// 冒烟测试专用：不做 docker 检测，直接返回给定容器名，便于验证执行逻辑本身。
export function runSupabaseRegressionAgainst(container) {
  console.log(`  容器: ${container}`);
  for (const regression of SUPABASE_REGRESSIONS) {
    const absolutePath = path.join(root, regression.file);
    const sql = fs.readFileSync(absolutePath, 'utf8');
    const extraArgs = regression.fixtureArgs ? regression.fixtureArgs() : [];
    console.log(`  -> ${regression.file}`);
    const result = spawnSync(
      'docker',
      ['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', ...extraArgs],
      {
        cwd: root,
        env: process.env,
        input: sql,
        stdio: ['pipe', 'inherit', 'inherit'],
      },
    );
    if (result.error || result.status !== 0) {
      return result;
    }
  }
  return { status: 0 };
}

export function runSupabaseRegressionGate() {
  let container;
  try {
    container = detectSupabaseContainer();
  } catch (error) {
    console.error(error.message);
    return { status: 1, error };
  }
  if (!container) {
    console.log(
      '\x1b[33m%s\x1b[0m',
      'SKIP: Supabase 回归未执行（未检测到本地容器）——契约类改动合入前必须手工执行',
    );
    return { status: 0 };
  }
  return runSupabaseRegressionAgainst(container);
}

const checks = [
  ['version consistency', npm, ['run', 'version:check']],
  // 排在最前：超长路径会让 Windows runner 在 checkout 阶段就失败，后面的门禁
  // 一条都跑不到，所以它必须比任何编译型检查更早给出可读的失败原因。
  ['tracked path length', npm, ['run', 'check:paths']],
  ['tracked path length tests', npm, ['run', 'test:paths']],
  // JEID-38：run 挂死 1h43m 以前只能靠人工发现。run 健康探针的契约（状态判定、
  // 退出码、缺 CLI 退化为 unknown）必须在门禁里跑，否则它自己也会成为盲区。
  ['run health probe tests', npm, ['run', 'test:run-health']],
  ['Android widget preview assets', npm, ['run', 'check:android:widget-previews']],
  ['brand asset consistency', npm, ['run', 'icons:check']],
  ['brand generator tests', npm, ['run', 'test:icons']],
  ['TypeScript', npm, ['run', 'typecheck']],
  ['ESLint (react-hooks)', npm, ['run', 'lint']],
  ['frontend contracts', npm, ['run', 'test:frontend']],
  ['frontend unit tests (vitest)', npm, ['run', 'test:unit']],
  // 与 CI frontend-check 的时区重跑同一组：今日/本周/本月按本地零点切分是高频事故区，
  // 只在宿主时区（Asia/Shanghai）跑会漏掉 UTC+14 这类日期已翻页的边界（T10.317 发现）。
  ['frontend unit tests (TZ=Pacific/Kiritimati)', npm, ['run', 'test:unit'], { TZ: 'Pacific/Kiritimati' }],
  ['frontend contracts (TZ=Asia/Kathmandu)', npm, ['run', 'test:frontend'], { TZ: 'Asia/Kathmandu' }],
  // CI frontend-check 一直跑这两组；本地门禁此前不含，导致 1.2.73 起主干
  // 连续红而台账仍记「全链门禁通过」。本地与 CI 必须是同一集合。
  ['release manifest tests', npm, ['run', 'test:release-manifest']],
  ['release security tests', npm, ['run', 'test:release-security']],
  ['frontend production build', npm, ['run', 'build:web']],
  ['chart bundle budget', process.execPath, ['scripts/check-bundle-budget.mjs']],
  ['native window probe contract', npm, ['run', 'test:native:contract']],
  ['SQL test container selection', process.execPath, ['--test', 'scripts/run-checks.test.mjs']],
  ['Supabase SQL regression', runSupabaseRegressionGate],
  ['Rust clippy', npm, ['run', 'lint:rust:clippy']],
  ['Rust fmt check', npm, ['run', 'lint:rust:fmt']],
  ['Rust tests', npm, ['run', 'test:rust']],
  // 与 CI rust-test 一致：chrono 的 Local 在 unix 上尊重 TZ，用 +05:45 非整点时区再跑一遍。
  ['Rust tests (TZ=Asia/Kathmandu)', npm, ['run', 'test:rust'], { TZ: 'Asia/Kathmandu' }],
  ['unstaged whitespace errors', git, ['diff', '--check']],
  ['staged whitespace errors', git, ['diff', '--cached', '--check']],
];

// 仅在直接执行本脚本（`npm run check` / `node scripts/run-checks.mjs`）时才跑完整门禁；
// 以模块方式 import（例如对 runSupabaseRegressionGate 之类导出函数做单独冒烟测试）
// 不会触发整条流水线，避免与并行改动互相干扰。
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const before = snapshot();
  let failedCheck = null;

  for (const check of checks) {
    const [label, command, args, extraEnv] = check;
    console.log(`\n==> ${label}`);
    let result;
    if (typeof command === 'function') {
      result = command();
    } else {
      const useShell = process.platform === 'win32' && command.endsWith('.cmd');
      result = spawnSync(command, args, {
        cwd: root,
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
        stdio: 'inherit',
        shell: useShell,
      });
    }
    if (result.error || result.status !== 0) {
      failedCheck = { label, result };
      break;
    }
  }

  const mutations = changedTrackedFiles(before, snapshot());
  if (mutations.length > 0) {
    console.error('\nCheck pipeline modified tracked files:');
    for (const file of mutations) {
      console.error(`  - ${file}`);
    }
    process.exit(1);
  }

  if (failedCheck) {
    if (failedCheck.result.error) {
      console.error(`\n${failedCheck.label} could not start: ${failedCheck.result.error.message}`);
    } else {
      console.error(`\n${failedCheck.label} failed with exit code ${failedCheck.result.status}.`);
    }
    process.exit(failedCheck.result.status || 1);
  }

  console.log('\nAll checks passed; tracked files are unchanged.');
}
