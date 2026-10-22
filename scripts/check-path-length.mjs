// 跟踪路径长度门禁。
//
// 2026-08-23 事故：`c22a4f05`（T10.71）新增的两张 Compose golden，仓库内相对路径
// 长到 234 / 232 字符。GitHub Windows runner 把仓库检出到 `D:\a\<repo>\<repo>\`，
// 加上这个前缀就越过了 Windows `MAX_PATH`，`actions/checkout@v4` 直接以
// `Filename too long` 失败——`Rust Windows Clippy & Tests`、`Windows Tauri Native
// Build` 和 release 工作流里签名 MSI 的 `windows` job 全部卡在检出，一次都没跑到
// 各自的门禁。macOS/Linux 开发机与开了 `core.longpaths` 的 Windows 机器完全无感，
// 所以这个洞靠人工评审发现不了，必须机器化。
//
// 本门禁只看仓库内相对路径长度，不看本机是否开了长路径支持。

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Windows `MAX_PATH` 是 260，含结尾 NUL，因此可用字符为 259。 */
const WINDOWS_MAX_PATH_USABLE = 259;

/** GitHub Actions Windows runner 的固定工作区前缀：`D:\a\<repo>\<repo>\`。 */
export function runnerPrefixLength(repositoryName) {
  return `D:\\a\\${repositoryName}\\${repositoryName}\\`.length;
}

export const REPOSITORY_NAME = 'TokenLedger';

/** 仓库内相对路径的实际预算。 */
export const MAX_TRACKED_PATH_LENGTH =
  WINDOWS_MAX_PATH_USABLE - runnerPrefixLength(REPOSITORY_NAME);

// 已知超限项。每一条都必须写明归属任务，修完后连同 golden 一起删除本行。
// 门禁会在豁免项「已不存在」或「已不再超限」时主动失败，防止豁免表腐烂成
// 一张没人敢动的白名单。
export const KNOWN_OVER_BUDGET = [
  {
    path: 'apps/android/app/src/screenshotTestDebug/reference/com/jeidorf/tokenledger/mobile/LedgerDashboardScreenshotTestKt/LowPowerDisplayAmbientConsoleLongQuotaIdentitiesScreenshot_Ambient console long quota identities 1194x834_4013e400_0.png',
    owner: 'T10.77',
    reason: 'Compose golden 文件名由 Preview 方法名派生，重命名必须在能跑 Gradle 的机器上重生成',
  },
  {
    path: 'apps/android/app/src/screenshotTestDebug/reference/com/jeidorf/tokenledger/mobile/LedgerDashboardScreenshotTestKt/LowPowerDisplayAmbientLedgerLongQuotaIdentitiesScreenshot_Ambient ledger long quota identities 1194x834_b107c572_0.png',
    owner: 'T10.77',
    reason: 'Compose golden 文件名由 Preview 方法名派生，重命名必须在能跑 Gradle 的机器上重生成',
  },
];

export function evaluateTrackedPaths(trackedPaths, limit = MAX_TRACKED_PATH_LENGTH, exemptions = KNOWN_OVER_BUDGET) {
  const exemptByPath = new Map(exemptions.map((entry) => [entry.path, entry]));
  const tracked = new Set(trackedPaths);

  const violations = [];
  const staleExemptions = [];

  for (const file of trackedPaths) {
    if (file.length <= limit) continue;
    if (exemptByPath.has(file)) continue;
    violations.push({ file, length: file.length });
  }

  for (const entry of exemptions) {
    if (!tracked.has(entry.path)) {
      staleExemptions.push({ ...entry, why: '豁免项已不在仓库中' });
    } else if (entry.path.length <= limit) {
      staleExemptions.push({ ...entry, why: `豁免项已收敛到 ${entry.path.length} 字符` });
    }
  }

  violations.sort((a, b) => b.length - a.length);
  const longest = trackedPaths.reduce((max, file) => Math.max(max, file.length), 0);
  return { violations, staleExemptions, longest, limit, checked: trackedPaths.length };
}

export function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
}

function main() {
  const result = evaluateTrackedPaths(trackedFiles());
  const problems = [];

  for (const { file, length } of result.violations) {
    problems.push(`  ${length} 字符 > ${result.limit}：${file}`);
  }
  for (const entry of result.staleExemptions) {
    problems.push(`  豁免项已失效（${entry.why}），请从 KNOWN_OVER_BUDGET 删除：${entry.path}`);
  }

  if (problems.length > 0) {
    console.error(
      `路径长度门禁失败：仓库内相对路径预算为 ${result.limit} 字符`
      + `（Windows MAX_PATH ${WINDOWS_MAX_PATH_USABLE} − runner 前缀 ${runnerPrefixLength(REPOSITORY_NAME)}）。`,
    );
    console.error(problems.join('\n'));
    process.exitCode = 1;
    return;
  }

  const exempt = KNOWN_OVER_BUDGET.length;
  console.log(
    `路径长度门禁通过：${result.checked} 条跟踪路径，最长 ${result.longest} 字符，预算 ${result.limit}；`
    + `已登记豁免 ${exempt} 条（归属 ${[...new Set(KNOWN_OVER_BUDGET.map((e) => e.owner))].join('、') || '无'}）。`,
  );
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main();
}
