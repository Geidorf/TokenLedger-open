import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_APP = resolve('src-tauri/target/release/bundle/macos/tokenledger.app');
const EXECUTABLE_SUFFIX = '/Contents/MacOS/tokenledger';
// 等待进程出现的默认窗口。命中逻辑本身在 classifyExecutableMatch；这里只决定「等多久才算没起来」。
// 不传 `--wait-ms` 时行为必须与既有 CI/回归完全一致，所以默认值保持 5000。
const PROCESS_APPEAR_TIMEOUT_MS = 5000;
// `--wait-ms` 上界 1 小时：挡住把秒当毫秒之类的误传，同时足够覆盖人工放行 Gatekeeper 的耗时。
const MAX_WAIT_MS = 3600000;
const USAGE = 'Usage: npm run check:native:macos -- [--app path/to/tokenledger.app] [--require-active]'
  + ' [--check-single-instance] [--check-reopen] [--require-visible]'
  + ' [--wait-ms <ms>] [--attach]';
// quarantine 在位时 LaunchServices 走 AppTranslocation，把 app 复制到随机前缀再执行：
// /private/var/folders/…/T/AppTranslocation/<UUID>/d/<bundle>.app/Contents/MacOS/<exe>
const APP_TRANSLOCATION_SEGMENT = '/AppTranslocation/';
const MATCH_RANK = { exact: 4, realpath: 3, 'app-translocation': 2 };
const SWIFT_WINDOW_PROBE = String.raw`
import AppKit
import CoreGraphics
import Foundation

let pid = Int32(CommandLine.arguments[1])!
let frontmost = NSWorkspace.shared.frontmostApplication
let isActive = NSRunningApplication(processIdentifier: pid)?.isActive ?? false
let frontmostPid = frontmost?.processIdentifier ?? -1
let frontmostName = frontmost?.localizedName ?? ""
let windows = (CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]]) ?? []
let matches = windows.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }
print("frontmost=\(frontmostPid)|\(frontmostName)|active=\(isActive)")
print("count=\(matches.count)")
for window in matches {
    let name = window[kCGWindowName as String] as? String ?? ""
    let layer = window[kCGWindowLayer as String] as? Int ?? 0
    let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let x = bounds["X"] as? Double ?? 0
    let y = bounds["Y"] as? Double ?? 0
    let width = bounds["Width"] as? Double ?? 0
    let height = bounds["Height"] as? Double ?? 0
    print("window=\(name)|\(layer)|\(x)|\(y)|\(width)|\(height)")
}
`;

const SWIFT_PROCESS_LIST_PROBE = String.raw`
import AppKit

for app in NSWorkspace.shared.runningApplications {
    if let path = app.executableURL?.path {
        print("\(app.processIdentifier)|\(path)")
    }
}
`;

let nativeProcessProbe = null;
let nativeProcessProbeDir = null;

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

// --- 进程匹配：对 quarantine / AppTranslocation 与符号链接鲁棒 ---
//
// 旧实现按 `command.includes(executablePath)` 匹配。quarantine 在位时进程的完整可执行
// 路径被 LaunchServices 换成 AppTranslocation 随机前缀（只有 app bundle 尾部与
// `--app` 推导出的路径一致），于是 waitForPid 必然 5 秒超时，即使 app 已经正常上屏。

export function normalizeExecutablePath(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  // posix.normalize 会保留尾斜杠，而 ps / 用户传参的尾斜杠不应影响匹配。
  const normalized = posix.normalize(trimmed).replace(/\/+$/, '');
  return normalized === '' || normalized === '.' ? '' : normalized;
}

function resolvedPath(value) {
  try {
    return normalizeExecutablePath(realpathSync(value));
  } catch {
    return '';
  }
}

// `<bundle>.app/Contents/MacOS/<exe>` 是 app bundle 内可执行文件的稳定尾部。
export function appBundleTail(value) {
  const match = normalizeExecutablePath(value).match(/(?:^|\/)([^/]+\.app)\/Contents\/MacOS\/([^/]+)$/);
  return match ? `${match[1]}/Contents/MacOS/${match[2]}` : null;
}

export function isAppTranslocatedPath(value) {
  return normalizeExecutablePath(value).includes(APP_TRANSLOCATION_SEGMENT);
}

/**
 * 判断某个进程的可执行文件路径是否就是期望的那个 app 实例。
 * 命中优先级：exact（完整路径相同）> realpath（符号链接归一化后指向同一文件）>
 * app-translocation（隔离场景下前缀被换掉，路径在 AppTranslocation 内且 app bundle 尾部一致）。
 * 其它路径下的同名副本不算命中（那是另一份安装），只在失败诊断里列为候选。
 */
export function classifyExecutableMatch(candidate, expected) {
  const candidatePath = normalizeExecutablePath(candidate);
  const expectedPath = normalizeExecutablePath(expected);
  if (!candidatePath || !expectedPath) return null;
  if (candidatePath === expectedPath) return 'exact';

  const sameBasename = posix.basename(candidatePath).toLowerCase()
    === posix.basename(expectedPath).toLowerCase();
  if (sameBasename) {
    const candidateReal = resolvedPath(candidatePath);
    const expectedReal = resolvedPath(expectedPath);
    if (candidateReal && expectedReal && candidateReal === expectedReal) return 'realpath';
  }

  if (isAppTranslocatedPath(candidatePath)) {
    const candidateTail = appBundleTail(candidatePath);
    const expectedTail = appBundleTail(expectedPath);
    // macOS 默认大小写不敏感卷上 bundle 名可能是 TokenLedger.app / tokenledger.app。
    if (candidateTail && expectedTail && candidateTail.toLowerCase() === expectedTail.toLowerCase()) {
      return 'app-translocation';
    }
  }
  return null;
}

// 失败诊断用：同 basename 或同 app bundle 尾部的进程才可能是「我们要找的那个」。
export function selectDiagnosticCandidates(records, executable, limit = 8) {
  const expectedBasename = posix.basename(normalizeExecutablePath(executable)).toLowerCase();
  const expectedTail = appBundleTail(executable);
  return records
    .filter((record) => {
      const path = processRecordPath(record, executable);
      if (posix.basename(path).toLowerCase() === expectedBasename) return true;
      const tail = appBundleTail(path);
      return Boolean(tail && expectedTail && tail.toLowerCase() === expectedTail.toLowerCase());
    })
    .slice(0, limit);
}

function describeCandidate(record, executable) {
  const path = processRecordPath(record, executable) || '(无法解析 argv[0])';
  const expectedTail = appBundleTail(executable);
  const tail = appBundleTail(path);
  let reason = '可执行文件名相同但所在 app bundle 不同';
  if (isAppTranslocatedPath(path)) reason = '路径在 AppTranslocation 内但 app bundle 尾部不一致';
  else if (tail && expectedTail && tail.toLowerCase() === expectedTail.toLowerCase()) {
    reason = 'app bundle 尾部一致但路径不在 AppTranslocation 内（例如从 DMG 或另一份副本运行）';
  }
  return `pid=${record.pid} ${path}（${reason}）`;
}

/**
 * 匹配失败时的可诊断输出：期望路径、探针来源、同类候选进程（标注 AppTranslocation）
 * 一次给全，避免操作者只看到一个裸的 5 秒超时。
 */
export function describeMissingProcess(executable, observation, elapsedMs, { attach = false } = {}) {
  const lines = [`TokenLedger process did not appear within ${elapsedMs}ms: ${executable}`];
  if (attach) {
    lines.push('  attach 模式：不启动、不清理任何实例；请先手动启动目标 app，或调大 --wait-ms 后重跑。');
  }
  if (!observation) {
    lines.push('  process probe: 没有完成任何一次进程枚举');
    return lines.join('\n');
  }
  lines.push(`  process probe: ${observation.source}；期望可执行文件存在=${existsSync(executable) ? 'yes' : 'no'}`);
  const candidates = selectDiagnosticCandidates(observation.records ?? [], executable);
  if (candidates.length === 0) {
    lines.push('  同类候选进程：0 个（同 basename / 同 app bundle 尾部的进程都没有）');
    lines.push(
      '  提示：隔离下的进程路径形如 /private/var/folders/…/T/AppTranslocation/<UUID>/d/'
        + '<bundle>.app/Contents/MacOS/<exe>；候选为空说明 app 根本没起来，'
        + '先看 Console.app 里 LaunchServices / Gatekeeper 的拒绝记录。',
    );
  } else {
    lines.push(`  同类候选进程（${candidates.length} 个，均未命中匹配规则）：`);
    candidates.forEach((record) => lines.push(`    ${describeCandidate(record, executable)}`));
  }
  return lines.join('\n');
}

export function describeBundleExecutables(app) {
  const macosDir = join(app, 'Contents', 'MacOS');
  if (!existsSync(macosDir)) return '';
  let entries = [];
  try {
    entries = readdirSync(macosDir);
  } catch {
    return '';
  }
  return entries.length > 0 ? `；bundle 内 Contents/MacOS 实际内容：${entries.join(', ')}` : '';
}

// `--wait-ms` 只接受正整数毫秒；非法值必须报错退出，不得静默回退默认值（否则会拿 5 s 去跑
// 人-paced 的放行流程，产出假失败）。
export function parseWaitMs(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`invalid --wait-ms value: ${raw || '(missing)'} (expect positive integer milliseconds)`);
  }
  const waitMs = Number(raw);
  if (waitMs < 1 || waitMs > MAX_WAIT_MS) {
    throw new Error(`invalid --wait-ms value: ${raw} (expect 1..${MAX_WAIT_MS})`);
  }
  return waitMs;
}

export function parseArguments(argv) {
  const options = {
    app: DEFAULT_APP,
    requireActive: false,
    checkSingleInstance: false,
    checkReopen: false,
    requireVisible: false,
    attach: false,
    waitMs: PROCESS_APPEAR_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--app') {
      options.app = resolve(argv[++index] ?? '');
    } else if (argument === '--require-active') {
      options.requireActive = true;
    } else if (argument === '--check-single-instance') {
      options.checkSingleInstance = true;
    } else if (argument === '--check-reopen') {
      options.checkReopen = true;
    } else if (argument === '--require-visible') {
      options.requireVisible = true;
    } else if (argument === '--wait-ms') {
      options.waitMs = parseWaitMs(argv[++index]);
    } else if (argument === '--attach' || argument === '--no-launch') {
      options.attach = true;
    } else if (argument === '--help' || argument === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  // `--attach` 不启动也不清理实例，与「第二次启动必须复用既有 pid」的 single-instance /
  // reopen 探针语义互斥；显式报错，不静默降级成其中一个。
  if (options.attach && (options.checkSingleInstance || options.checkReopen)) {
    throw new Error('--attach cannot be combined with --check-single-instance / --check-reopen');
  }
  return options;
}

export function parseProcessRows(output) {
  return output
    .split('\n')
    .map((row) => row.trim())
    .map((row) => {
      const match = row.match(/^(\d+)\|(.+)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    })
    .filter(Boolean);
}

export function parsePsRows(output) {
  return output
    .split('\n')
    .map((row) => row.trim())
    .map((row) => {
      const match = row.match(/^(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    })
    .filter(Boolean);
}

// Rosetta / LaunchServices 有时会先 exec 一个包装器再 exec 应用（`/usr/bin/arch -arm64 <app> …`），
// 此时 ps 的 command 里 argv[0] 是包装器，应用路径落在第二段。这里只剥离白名单内的包装器与它
// 自己的 flag 参数，再套用既有匹配；不能放宽成「整行里出现期望路径就算命中」，否则参数或日志里
// 出现同名字符串也会误命中（那正是相对基线的收窄要补回来的那一处）。
const LAUNCHER_WRAPPERS = new Set(['/usr/bin/arch', '/bin/arch', 'arch']);

export function stripLauncherWrapper(command) {
  const trimmed = String(command ?? '').trim();
  if (!trimmed) return '';
  const tokens = trimmed.split(/\s+/u);
  let index = 0;
  while (index < tokens.length && LAUNCHER_WRAPPERS.has(tokens[index])) {
    index += 1;
    // 包装器自身的 flag（例如 `arch -arm64`）不属于目标命令行。
    while (index < tokens.length && tokens[index].startsWith('-')) index += 1;
  }
  return index === 0 ? trimmed : tokens.slice(index).join(' ');
}

// ps 的 command 列是完整命令行，argv[0] 才是可执行文件路径；`--minimized` 之类的参数不参与匹配。
//
// 注意：argv 是空格拼接的，路径含空格时「取首个 token」会把 argv[0] 截断（基线用整行 includes
// 匹配反而不会），于是永远不命中、必然超时误判。因此已知期望路径时先按「期望路径 + 参数边界」
// 匹配；未知期望路径时再退回首个 token（与旧行为一致）。AppTranslocation 前缀被换掉时用
// app bundle 尾部定位 argv[0] 的结尾。前置包装器先按白名单剥离，否则包装器下永不命中（基线命中）。
export function processExecutablePath(command, expectedExecutable = '') {
  const trimmed = String(command ?? '').trim();
  if (!trimmed) return '';

  const expected = normalizeExecutablePath(expectedExecutable);
  const candidateLine = expected ? stripLauncherWrapper(trimmed) : trimmed;
  if (!candidateLine) return '';

  if (expected && (candidateLine === expected || candidateLine.startsWith(`${expected} `))) return expected;

  const expectedTail = appBundleTail(expected);
  if (expectedTail) {
    const tailIndex = candidateLine.toLowerCase().indexOf(expectedTail.toLowerCase());
    const afterTail = tailIndex < 0 ? undefined : candidateLine[tailIndex + expectedTail.length];
    // 尾部必须落在路径末端或参数边界上，否则说明命中的是别的参数内容。
    if (tailIndex >= 0 && (afterTail === undefined || /\s/u.test(afterTail))) {
      return candidateLine.slice(0, tailIndex + expectedTail.length);
    }
  }

  const [firstToken = ''] = candidateLine.split(/\s+/);
  return firstToken;
}

// Swift native 探针的 `executableURL.path` 是完整路径，没有 argv 拼接歧义，优先于命令行解析。
export function processRecordPath(record, executable = '') {
  const explicit = normalizeExecutablePath(record?.path ?? '');
  return explicit || processExecutablePath(record?.command, executable);
}

// attach 的断言语义取自「被附着实例自身的启动参数」，而这条信息只有 ps 的命令行列才有
// （native 探针只返回 `pid|executableURL.path`，没有命令行）。这里按 pid 关联两路记录：路径以
// native 为准（无 argv 拼接歧义），命令行以 ps 为准（含 `--minimized` / `--show`）。
// ps 不可用时不猜、也不降级成报告型成功：合并结果里没有启动参数，attach 就没有生效断言。
export function mergeProcessRecords(pathRecords, commandRecords) {
  const commandByPid = new Map(
    (commandRecords ?? []).map((record) => [record.pid, record.command ?? '']),
  );
  return (pathRecords ?? []).map((record) => ({
    pid: record.pid,
    path: record.path ?? processExecutablePath(record.command),
    command: commandByPid.get(record.pid) ?? record.command ?? '',
  }));
}

// 从 ps 的 command 列里切出 argv[0] 之后的参数；已知 argv[0] 时按前缀切，避免路径含空格时
// 把路径片段当成参数（附着模式要靠它判断实例是用 --minimized 还是 --show 启动的）。
export function extractCommandArguments(command, executablePath = '') {
  const trimmed = stripLauncherWrapper(command);
  if (!trimmed) return [];
  const executable = normalizeExecutablePath(executablePath);
  let rest;
  if (executable && (trimmed === executable || trimmed.startsWith(`${executable} `))) {
    rest = trimmed.slice(executable.length).trim();
  } else {
    const [, ...others] = trimmed.split(/\s+/);
    rest = others.join(' ');
  }
  return rest ? rest.split(/\s+/).filter(Boolean) : [];
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function nativeProcessProbePath() {
  if (nativeProcessProbe) return nativeProcessProbe;

  const probeDir = mkdtempSync(join(tmpdir(), 'tokenledger-native-process-probe-'));
  const sourcePath = join(probeDir, 'probe.swift');
  const binaryPath = join(probeDir, 'probe');
  const moduleCachePath = join(probeDir, 'module-cache');
  try {
    writeFileSync(sourcePath, SWIFT_PROCESS_LIST_PROBE, 'utf8');
    execFileSync(
      'swiftc',
      ['-framework', 'AppKit', '-module-cache-path', moduleCachePath, '-o', binaryPath, sourcePath],
      { stdio: 'pipe' },
    );
    nativeProcessProbeDir = probeDir;
    nativeProcessProbe = binaryPath;
    return binaryPath;
  } catch (error) {
    rmSync(probeDir, { recursive: true, force: true });
    throw error;
  }
}

// 进程枚举优先用 Swift native 探针：`NSWorkspace.runningApplications` 给出的
// `executableURL.path` 是无歧义的完整路径，而 `ps -axo command=` 的 argv 空格拼接在路径含
// 空格时会被截断（相对基线的回退）；`ps` 只作兜底，两侧都拿不到记录才算探针不可用。
function nativeProcessRecords() {
  return parseProcessRows(execFileSync(nativeProcessProbePath(), [], { encoding: 'utf8' }))
    .map((record) => ({ ...record, path: record.command }));
}

function psProcessRecords() {
  return parsePsRows(execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }));
}

function listProcessRecords() {
  const failures = [];
  try {
    const records = nativeProcessRecords();
    if (records.length > 0) return { source: 'native', records };
    failures.push('native=没有枚举到任何进程');
  } catch (nativeError) {
    failures.push(`native=${errorMessage(nativeError)}`);
  }
  try {
    const records = psProcessRecords();
    if (records.length > 0) return { source: 'ps', records };
    failures.push('ps=没有枚举到任何进程');
  } catch (psError) {
    failures.push(`ps=${errorMessage(psError)}`);
  }
  throw new Error(`process inspection unavailable: ${failures.join('; ')}`);
}

export function findExecutableProcesses(executable) {
  const { source, records } = listProcessRecords();
  const matches = records
    .map((record) => {
      const path = processRecordPath(record, executable);
      return {
        pid: record.pid,
        path,
        kind: classifyExecutableMatch(path, executable),
        command: record.command ?? '',
      };
    })
    .filter((match) => match.kind !== null)
    // exact > realpath > app-translocation；同一级别取最新（pid 最大）的一个。
    .sort(
      (left, right) => (MATCH_RANK[right.kind] ?? 0) - (MATCH_RANK[left.kind] ?? 0)
        || right.pid - left.pid,
    );
  return { source, records, matches };
}

function findPids(executable) {
  return findExecutableProcesses(executable).matches.map((match) => match.pid);
}

process.once('exit', () => {
  if (nativeProcessProbeDir) {
    rmSync(nativeProcessProbeDir, { recursive: true, force: true });
  }
});

function findLatestProcessMatch(executable, ignoredPids = new Set()) {
  return findExecutableProcesses(executable).matches
    .find((match) => !ignoredPids.has(match.pid)) ?? null;
}

// 上屏语义的静态守卫只看 `CGWindowListCopyWindowInfo(` 的实参形态：把 `.optionOnScreenOnly`
// 换成 `.optionAll` 必须红灯，而源码里（注释、字符串里）出现 `.optionAll` 字样不该误伤门禁。
export function windowProbeFilterArguments(source) {
  return [...String(source ?? '').matchAll(/CGWindowListCopyWindowInfo\(([^,()]+),/gu)]
    .map((match) => match[1].trim());
}

export function parseFrontmostState(frontmost, pid) {
  const fields = frontmost.split('|');
  return {
    frontmost,
    frontmostPid: Number(fields[0]),
    frontmostName: fields[1] ?? '',
    active: fields.at(-1) === 'active=true',
    pid,
  };
}

export function isExpectedActiveWindow(state) {
  return state.active && state.frontmostPid === state.pid;
}

export function parseWindowRows(lines) {
  return lines
    .filter((line) => line.startsWith('window='))
    .map((line) => {
      const [name, layer, x, y, width, height] = line.slice('window='.length).split('|');
      return {
        name,
        layer: Number(layer),
        x: Number(x),
        y: Number(y),
        width: Number(width),
        height: Number(height),
      };
    })
    .filter((window) => [window.layer, window.x, window.y, window.width, window.height].every(Number.isFinite));
}

function probeWindows(pid) {
  const result = spawnSync('swift', ['-', String(pid)], {
    input: SWIFT_WINDOW_PROBE,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Swift window probe failed:\n${result.stderr}`);
  }
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const frontmost = lines.find((line) => line.startsWith('frontmost='))?.slice('frontmost='.length) ?? 'unknown';
  const frontmostState = parseFrontmostState(frontmost, pid);
  const count = Number(lines.find((line) => line.startsWith('count='))?.slice('count='.length) ?? NaN);
  const windows = parseWindowRows(lines);
  const main = windows.find((window) => window.name === 'TokenLedger') ?? null;
  const wallpaper = windows.find((window) => window.name === 'TokenLedger Wallpaper') ?? null;
  if (!Number.isInteger(count) || count < 0) throw new Error(`Invalid Swift probe output: ${result.stdout}`);
  return { count, main, wallpaper, windows, ...frontmostState };
}

// 命中来源要留痕，而且必须在任何等待/附着/窗口读取动作之前打出来：第一次 Mac 运行要靠这一行
// 直接读出本次是 exact 还是 app-translocation（回答「批准『仍要打开』后是否仍被隔离」）。
// exact 也要打印——只在非 exact 打印等于第一次运行读不到答案。
export function formatProcessMatch(match, phase = '') {
  return `process match${phase ? ` (${phase})` : ''}:`
    + ` pid=${match.pid} kind=${match.kind} path=${match.path}`;
}

// 首次枚举要把 Swift native 探针编译出来（swiftc），这段耗时不能算进 --wait-ms 计时面：
// 否则默认 5s 窗口会被编译吃掉，等待语义就不准了。这里失败不抛错，真正的故障由轮询报告。
function warmUpProcessProbe() {
  try {
    listProcessRecords();
  } catch {
    // 故意忽略：轮询里的同一条路径会给出带原因的硬失败。
  }
}

// `--wait-ms` 超时必须硬失败：不得「等不到就当成功」，也不得静默回退默认值。
export async function waitForPid(executable, ignoredPids, waitMs, {
  attach = false,
  listProcesses = findExecutableProcesses,
  warmUp = warmUpProcessProbe,
  wait = sleep,
  now = Date.now,
} = {}) {
  warmUp();
  const startedAt = now();
  const deadline = startedAt + waitMs;
  let observation = null;
  do {
    observation = listProcesses(executable);
    const match = observation.matches.find((candidate) => !ignoredPids.has(candidate.pid)) ?? null;
    if (match) {
      console.log(formatProcessMatch(match));
      return match;
    }
    if (now() >= deadline) break;
    await wait(100);
  } while (true);
  throw new Error(describeMissingProcess(executable, observation, now() - startedAt, { attach }));
}

// 附着模式按被附着实例自身的启动参数选择断言语义：`--minimized` 仍断言无上屏主窗口，
// `--show` 仍断言主窗口 + 尺寸；启动参数取不到时返回 `null`，由 `attachAssertions` 判定
// 「本次到底有没有生效断言」——没有任何生效断言一律硬失败，不打印 passed。
// 优先级必须与 app 自身语义一致：`src-tauri/src/lib.rs` 的 `should_start_minimized` 是
// `--show` 胜（Rust 用例 `explicit_show_wins_when_minimized_is_also_present`），两个 flag
// 同时在场时先判 `--minimized` 会给出与产品语义相反的判定（假失败面）。
export function attachVisibilityExpectation(command, executablePath = '') {
  const args = extractCommandArguments(command, executablePath);
  if (args.includes('--show')) return 'visible';
  if (args.includes('--minimized')) return 'minimized';
  return null;
}

// attach 模式下到底要断言什么，必须是「实际会执行的那几条」的唯一事实源：
// 摘要行与 PASS 行都写它，不再出现 `expectation=none … passed` 这种无断言绿灯。
export function attachAssertions(expectation, { requireVisible = false, requireActive = false } = {}) {
  const assertions = [];
  if (expectation === 'minimized') assertions.push('startup-args:--minimized');
  if (expectation === 'visible') assertions.push('startup-args:--show');
  if (requireVisible) assertions.push('--require-visible');
  if (requireActive) assertions.push('--require-active');
  return assertions;
}

export const ATTACH_NO_ASSERTION_ERROR = 'attach mode has no effective assertion: the attached instance did not start with'
  + ' --minimized / --show (or the ps command line was unavailable) and neither --require-visible nor'
  + ' --require-active was given; “report-only” output is not on-screen evidence';

// `--attach`：不 `open`、不 kill，只附着到已在运行的实例再读窗口做上屏断言。
// 人工走完 Gatekeeper / 『仍要打开』放行流程后再跑（等待窗口可用 `--wait-ms` 显式放大），
// 人-paced 环节不再有「探针先超时、再清掉实例」的假失败面。
// 断言的启动参数口径：native 供路径、ps 供参数，按 pid 关联两路记录（`mergeProcessRecords`）。
export async function runAttachProbe(app, { waitMs, requireVisible, requireActive }, deps = {}) {
  const {
    listProcesses = findExecutableProcesses,
    commandRecords = psProcessRecords,
    readWindows = probeWindows,
    warmUp = warmUpProcessProbe,
    wait = sleep,
    log = console.log,
  } = deps;
  const executable = `${app}${EXECUTABLE_SUFFIX}`;
  const match = await waitForPid(executable, new Set(), waitMs, {
    attach: true,
    listProcesses,
    warmUp,
    wait,
  });

  // ps 不可用（或被守卫拒绝）时不造启动参数：合并结果没有参数 → 没有生效断言 → 下面硬失败。
  let psRecords = [];
  try {
    psRecords = commandRecords() ?? [];
  } catch {
    psRecords = [];
  }
  const [attached] = mergeProcessRecords([match], psRecords);
  const expectation = attachVisibilityExpectation(attached.command, attached.path);

  // `--minimized` 断言「没有上屏主窗口」，`--require-visible` 断言「有主窗口」：同时给等于
  // 其中一条被静默忽略，而摘要行会声称两条都生效——直接报错，不挑一条执行。
  if (expectation === 'minimized' && requireVisible) {
    throw new Error('--require-visible conflicts with the attached instance --minimized startup argument');
  }
  const assertions = attachAssertions(expectation, { requireVisible, requireActive });
  if (assertions.length === 0) throw new Error(ATTACH_NO_ASSERTION_ERROR);

  await wait(1500);
  const windows = readWindows(match.pid);
  log(
    `attach: pid=${match.pid} kind=${match.kind} assertions=${assertions.join('+')} `
    + `on-screen windows=${windows.count} main=${formatWindow(windows.main)} `
    + `wallpaper=${formatWindow(windows.wallpaper)} frontmost=${windows.frontmost}`,
  );
  if (expectation === 'minimized' && windows.main) {
    throw new Error('Expected --minimized to leave no on-screen main window');
  }
  if (
    expectation === 'visible'
    && (windows.count < 1 || !windows.main || windows.main.width < 1024 || windows.main.height < 680)
  ) {
    throw new Error('Expected --show to expose a non-zero TokenLedger main window');
  }
  if (requireVisible && (windows.count < 1 || !windows.main)) {
    throw new Error('Expected the attached instance to expose a TokenLedger main window');
  }
  if (requireActive && !isExpectedActiveWindow(windows)) {
    throw new Error(`Expected the attached instance to be frontmost; observed pid=${match.pid} frontmost=${windows.frontmost}`);
  }
  log(`macOS native window smoke passed (attach, assertions=${assertions.join('+')})`);
}

async function runProbe(app, args, label, waitMs) {
  const executable = `${app}${EXECUTABLE_SUFFIX}`;
  const existingPids = new Set(findPids(executable));
  const child = spawn('open', ['-n', app, '--args', ...args], { stdio: 'ignore' });
  // pid 的等待放进 try：否则 waitForPid 失败时 finally 里的清理不会执行，探针会在
  // 目标机上留下一堆没被杀掉的实例（下一次探测还要把它们当成既有进程排除）。
  let pid = null;
  try {
    pid = (await waitForPid(executable, existingPids, waitMs)).pid;
    await sleep(1500);
    // Some macOS launch paths replace the first process after the app has
    // finished registering its native shell. Re-bind to the newest process
    // created by this probe before reading its windows.
    const rebound = findLatestProcessMatch(executable, existingPids);
    if (rebound && rebound.pid !== pid) {
      console.log(formatProcessMatch(rebound, 'rebound'));
      pid = rebound.pid;
    }
    const windows = probeWindows(pid);
    console.log(
      `${label}: pid=${pid} on-screen windows=${windows.count} `
      + `main=${formatWindow(windows.main)} wallpaper=${formatWindow(windows.wallpaper)} `
      + `frontmost=${windows.frontmost}`,
    );
    return windows;
  } finally {
    // 枚举失败不能盖掉真正的失败原因（例如上面那条带候选进程列表的诊断）。
    let launchedPids = new Set();
    try {
      launchedPids = new Set(findPids(executable).filter((candidate) => !existingPids.has(candidate)));
    } catch {
      launchedPids = new Set();
    }
    if (pid) launchedPids.add(pid);
    for (const launchedPid of launchedPids) {
      try {
        process.kill(launchedPid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    child.kill('SIGTERM');
  }
}

function formatWindow(window) {
  return window
    ? `${window.width}x${window.height}@${window.x},${window.y}/layer=${window.layer}`
    : 'none';
}

async function runSingleInstanceProbe(app, requireVisible, waitMs) {
  const executable = `${app}${EXECUTABLE_SUFFIX}`;
  const existingPids = new Set(findPids(executable));
  const launchedChildren = [];
  const launchedPids = new Set();
  try {
    const first = spawn('open', ['-n', app, '--args', '--minimized'], { stdio: 'ignore' });
    launchedChildren.push(first);
    const firstPid = (await waitForPid(executable, existingPids, waitMs)).pid;
    launchedPids.add(firstPid);
    await sleep(1500);
    const firstPids = findPids(executable).filter((pid) => !existingPids.has(pid));
    if (firstPids.length !== 1) {
      throw new Error(`Expected one TokenLedger process after first launch; observed ${firstPids.length}`);
    }

    const second = spawn('open', ['-n', app, '--args', '--show'], { stdio: 'ignore' });
    launchedChildren.push(second);
    await sleep(1500);
    const secondPids = findPids(executable).filter((pid) => !existingPids.has(pid));
    secondPids.forEach((pid) => launchedPids.add(pid));
    if (secondPids.length !== 1 || secondPids[0] !== firstPid) {
      throw new Error(
        `Expected the second launch to reuse pid=${firstPid}; observed pids=${secondPids.join(',') || 'none'}`,
      );
    }

    const windows = probeWindows(firstPid);
    console.log(
      `single-instance: pid=${firstPid} processes=${secondPids.length} on-screen windows=${windows.count} main=${formatWindow(windows.main)} wallpaper=${formatWindow(windows.wallpaper)} frontmost=${windows.frontmost}`,
    );
    if (requireVisible && (windows.count < 1 || !windows.main)) {
      throw new Error('Expected the second launch to restore the existing TokenLedger window');
    }
  } finally {
    const currentPids = findPids(executable).filter((pid) => !existingPids.has(pid));
    currentPids.forEach((pid) => launchedPids.add(pid));
    for (const launchedPid of launchedPids) {
      try {
        process.kill(launchedPid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    launchedChildren.forEach((child) => child.kill('SIGTERM'));
  }
}

async function runReopenProbe(app, requireVisible, waitMs) {
  const executable = `${app}${EXECUTABLE_SUFFIX}`;
  const existingPids = new Set(findPids(executable));
  const launchedChildren = [];
  const launchedPids = new Set();
  try {
    const first = spawn('open', ['-n', app, '--args', '--minimized'], { stdio: 'ignore' });
    launchedChildren.push(first);
    const firstPid = (await waitForPid(executable, existingPids, waitMs)).pid;
    launchedPids.add(firstPid);
    await sleep(1500);
    const firstPids = findPids(executable).filter((pid) => !existingPids.has(pid));
    if (firstPids.length !== 1) {
      throw new Error(`Expected one TokenLedger process before Dock reopen; observed ${firstPids.length}`);
    }

    // `open -a` follows the macOS application reopen path and must not rely
    // on a synthetic --show argument being forwarded by the launcher.
    const reopen = spawn('open', ['-a', app], { stdio: 'ignore' });
    launchedChildren.push(reopen);
    await sleep(1500);
    const reopenedPids = findPids(executable).filter((pid) => !existingPids.has(pid));
    reopenedPids.forEach((pid) => launchedPids.add(pid));
    if (reopenedPids.length !== 1 || reopenedPids[0] !== firstPid) {
      throw new Error(
        `Expected Dock reopen to reuse pid=${firstPid}; observed pids=${reopenedPids.join(',') || 'none'}`,
      );
    }

    const windows = probeWindows(firstPid);
    console.log(
      `reopen: pid=${firstPid} processes=${reopenedPids.length} on-screen windows=${windows.count} main=${formatWindow(windows.main)} wallpaper=${formatWindow(windows.wallpaper)} frontmost=${windows.frontmost}`,
    );
    if (requireVisible && (windows.count < 1 || !windows.main)) {
      throw new Error('Expected Dock reopen to restore the existing TokenLedger window');
    }
  } finally {
    const currentPids = findPids(executable).filter((pid) => !existingPids.has(pid));
    currentPids.forEach((pid) => launchedPids.add(pid));
    for (const launchedPid of launchedPids) {
      try {
        process.kill(launchedPid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    launchedChildren.forEach((child) => child.kill('SIGTERM'));
  }
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('macOS native window smoke is only supported on darwin');
  }
  const {
    app,
    requireActive,
    checkSingleInstance,
    checkReopen,
    requireVisible,
    attach,
    waitMs,
  } = parseArguments(process.argv.slice(2));
  const executablePath = `${app}${EXECUTABLE_SUFFIX}`;
  if (!existsSync(executablePath)) {
    throw new Error(`Release app executable not found: ${executablePath}${describeBundleExecutables(app)}`);
  }

  if (attach) {
    await runAttachProbe(app, { waitMs, requireVisible, requireActive });
    return;
  }

  if (checkSingleInstance) {
    await runSingleInstanceProbe(app, requireVisible, waitMs);
    console.log(`macOS single-instance smoke passed${requireVisible ? ' (visible restore)' : ' (process reuse)'}`);
    return;
  }

  if (checkReopen) {
    await runReopenProbe(app, requireVisible, waitMs);
    console.log(`macOS Dock reopen smoke passed${requireVisible ? ' (visible restore)' : ' (process reuse)'}`);
    return;
  }

  const minimized = await runProbe(app, ['--minimized'], 'minimized', waitMs);
  if (minimized.main) {
    throw new Error('Expected --minimized to leave no on-screen main window');
  }

  const shown = await runProbe(app, ['--show'], 'show', waitMs);
  if (
    shown.count < 1
    || !shown.main
    || shown.main.width < 1024
    || shown.main.height < 680
  ) {
    throw new Error('Expected --show to expose a non-zero TokenLedger main window');
  }
  if (requireActive && !isExpectedActiveWindow(shown)) {
    throw new Error(`Expected --show to activate TokenLedger; observed pid=${shown.pid} frontmost=${shown.frontmost}`);
  }
  console.log('macOS native window smoke passed');
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
