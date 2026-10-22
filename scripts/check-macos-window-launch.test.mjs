import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ATTACH_NO_ASSERTION_ERROR,
  appBundleTail,
  attachAssertions,
  attachVisibilityExpectation,
  classifyExecutableMatch,
  describeMissingProcess,
  extractCommandArguments,
  formatProcessMatch,
  isAppTranslocatedPath,
  isExpectedActiveWindow,
  mergeProcessRecords,
  parseArguments,
  parseProcessRows,
  parseFrontmostState,
  parsePsRows,
  parseWaitMs,
  parseWindowRows,
  processExecutablePath,
  processRecordPath,
  runAttachProbe,
  selectDiagnosticCandidates,
  stripLauncherWrapper,
  waitForPid,
  windowProbeFilterArguments,
} from './check-macos-window-launch.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./check-macos-window-launch.mjs', import.meta.url));

const SCRIPT_SOURCE = () => readFileSync(new URL('./check-macos-window-launch.mjs', import.meta.url), 'utf8');

// 静态守卫用：取出某个具名函数（或 async function）的函数体文本。
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(async )?function /u);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

// 匹配逻辑只面向 macOS 的 posix 路径；单元测试要在 Windows 上跑，所以把本机路径
// 统一成 posix 形态再喂进去（realpath 两侧都是同一形态，比较仍然成立）。
const toPosixPath = (value) => value.split(sep).join('/');

test('frontmost acceptance uses the target PID instead of localized app casing', () => {
  const state = parseFrontmostState('55028|tokenledger|active=true', 55028);

  assert.equal(state.frontmostName, 'tokenledger');
  assert.equal(isExpectedActiveWindow(state), true);
});

test('a different active frontmost window fails the native activation gate', () => {
  const state = parseFrontmostState('1236|Microsoft Edge|active=true', 55028);

  assert.equal(isExpectedActiveWindow(state), false);
});

test('native process probe parser keeps executable paths and ignores malformed rows', () => {
  const rows = parseProcessRows('42|/Applications/TokenLedger.app/Contents/MacOS/tokenledger\ninvalid\n');

  assert.deepEqual(rows, [
    { pid: 42, command: '/Applications/TokenLedger.app/Contents/MacOS/tokenledger' },
  ]);
});

// --- JEID-75：quarantine / AppTranslocation 下的进程匹配 -----------------------

const EXPECTED_EXECUTABLE = '/Applications/TokenLedger.app/Contents/MacOS/tokenledger';
const TRANSLOCATED_EXECUTABLE = '/private/var/folders/12/abcdefgh/T/AppTranslocation/9F3E-uuid/d/tokenledger.app/Contents/MacOS/tokenledger';

test('AppTranslocation 前缀下仍按 app bundle 尾部命中（修复前必然 5 秒超时）', () => {
  assert.equal(
    classifyExecutableMatch(TRANSLOCATED_EXECUTABLE, EXPECTED_EXECUTABLE),
    'app-translocation',
  );
  assert.equal(isAppTranslocatedPath(TRANSLOCATED_EXECUTABLE), true);
});

test('完整路径相同（含尾斜杠与 . / .. 噪声）仍是最强命中', () => {
  assert.equal(
    classifyExecutableMatch('/Applications/TokenLedger.app/./Contents/MacOS/../MacOS/tokenledger/', EXPECTED_EXECUTABLE),
    'exact',
  );
});

test('另一份安装的同名副本不算命中：不同 app bundle 且不在 AppTranslocation 内', () => {
  assert.equal(
    classifyExecutableMatch('/Users/me/Builds/TokenLedger.app/Contents/MacOS/tokenledger', EXPECTED_EXECUTABLE),
    null,
  );
  // 在 AppTranslocation 内但 bundle 尾部不同（例如启动的是另一个 app）也不命中。
  assert.equal(
    classifyExecutableMatch(
      '/private/var/folders/12/abcdefgh/T/AppTranslocation/9F3E-uuid/d/Other.app/Contents/MacOS/other',
      EXPECTED_EXECUTABLE,
    ),
    null,
  );
});

test('符号链接归一化后指向同一文件则命中 realpath 分支', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tl-probe-realpath-'));
  try {
    const realExecutable = join(root, 'real', 'tokenledger.app', 'Contents', 'MacOS', 'tokenledger');
    mkdirSync(join(root, 'real', 'tokenledger.app', 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(realExecutable, '');
    const linkedApp = join(root, 'linked');
    try {
      symlinkSync(join(root, 'real'), linkedApp, 'dir');
    } catch (error) {
      t.skip(`本机无法创建符号链接：${error.message}`);
      return;
    }
    const viaLink = join(linkedApp, 'tokenledger.app', 'Contents', 'MacOS', 'tokenledger');
    assert.equal(
      classifyExecutableMatch(toPosixPath(viaLink), toPosixPath(realExecutable)),
      'realpath',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ps 命令行只取 argv[0]：--minimized / --show 参数不得参与匹配', () => {
  assert.equal(
    processExecutablePath(`${TRANSLOCATED_EXECUTABLE} --minimized`),
    TRANSLOCATED_EXECUTABLE,
  );
  const rows = parsePsRows(
    `  42 ${TRANSLOCATED_EXECUTABLE} --show\nnot-a-row\n  43 /usr/bin/other\n`,
  );
  assert.deepEqual(rows, [
    { pid: 42, command: `${TRANSLOCATED_EXECUTABLE} --show` },
    { pid: 43, command: '/usr/bin/other' },
  ]);
  assert.deepEqual(appBundleTail(TRANSLOCATED_EXECUTABLE), 'tokenledger.app/Contents/MacOS/tokenledger');
});

test('匹配失败时输出可诊断信息：候选进程、AppTranslocation 标记与等待耗时', () => {
  const observation = {
    source: 'ps',
    records: [
      { pid: 4242, command: `${TRANSLOCATED_EXECUTABLE} --show` },
      { pid: 99, command: '/Applications/Other.app/Contents/MacOS/other' },
    ],
    matches: [],
  };
  const message = describeMissingProcess(EXPECTED_EXECUTABLE, observation, 5000);

  assert.match(message, /within 5000ms/);
  assert.match(message, /process probe: ps/);
  assert.match(message, /pid=4242 .*AppTranslocation/);
  assert.doesNotMatch(message, /pid=99/);
});

test('无任何同类进程时，诊断里给出 AppTranslocation 路径形态与下一步', () => {
  const message = describeMissingProcess(
    EXPECTED_EXECUTABLE,
    { source: 'native', records: [{ pid: 7, command: '/usr/sbin/cupsd' }], matches: [] },
    5000,
  );

  assert.match(message, /同类候选进程：0 个/);
  assert.match(message, /AppTranslocation/);
  assert.match(message, /Gatekeeper/);
});

test('诊断候选只收同 basename / 同 app bundle 尾部的进程', () => {
  const candidates = selectDiagnosticCandidates(
    [
      { pid: 1, command: '/usr/bin/node' },
      { pid: 2, command: `${TRANSLOCATED_EXECUTABLE} --minimized` },
      { pid: 3, command: '/Users/me/Builds/TokenLedger.app/Contents/MacOS/tokenledger' },
    ],
    EXPECTED_EXECUTABLE,
  );

  assert.deepEqual(candidates.map((record) => record.pid), [2, 3]);
});

test('上屏过滤必须保持 optionOnScreenOnly：不得用全窗口枚举顶替（JEID-58 裁定 1）', () => {
  const args = windowProbeFilterArguments(SCRIPT_SOURCE());

  assert.ok(args.length > 0, '窗口探针必须调用 CGWindowListCopyWindowInfo');
  args.forEach((argument) => {
    assert.equal(
      argument,
      '.optionOnScreenOnly',
      '窗口探针退化成全窗口枚举会抹平 --minimized 与 --show 的判别力',
    );
  });
});

test('上屏守卫只校验实参形态：注释里出现 .optionAll 不再误伤，真退化仍红灯', () => {
  const source = SCRIPT_SOURCE();

  // 注释 / 字符串里提到 .optionAll 不改变实参形态，不应当红灯。
  assert.deepEqual(windowProbeFilterArguments(`${source}\n// 变体说明：.optionAll 会抹平判别力\n`), ['.optionOnScreenOnly']);
  assert.deepEqual(windowProbeFilterArguments('// 将 .optionOnScreenOnly 换成 .optionAll 即退化\n'), []);
  // 真把实参换成 .optionAll（或换个枚举写法）必须被守卫判出。
  assert.deepEqual(
    windowProbeFilterArguments('let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID)'),
    ['.optionAll'],
  );
  assert.deepEqual(
    windowProbeFilterArguments('CGWindowListCopyWindowInfo( options, kCGNullWindowID)'),
    ['options'],
  );
});

test('window probe separates the main window and desktop wallpaper geometry', () => {
  const windows = parseWindowRows([
    'frontmost=42|TokenLedger|active=true',
    'window=TokenLedger|0|40|50|1280|860',
    'window=TokenLedger Wallpaper|-2147483627|0|0|3440|1440',
  ]);

  assert.deepEqual(windows, [
    { name: 'TokenLedger', layer: 0, x: 40, y: 50, width: 1280, height: 860 },
    {
      name: 'TokenLedger Wallpaper',
      layer: -2147483627,
      x: 0,
      y: 0,
      width: 3440,
      height: 1440,
    },
  ]);
});

// --- JEID-76：等待窗口可配置、附着模式、含空格路径与诊断时序 --------------------

const SPACED_EXPECTED = '/Applications/My Apps/TokenLedger.app/Contents/MacOS/tokenledger';
const SPACED_TRANSLOCATED = '/private/var/folders/12/ab cd/T/AppTranslocation/9F3E-uuid/d/TokenLedger.app/Contents/MacOS/tokenledger';

test('路径含空格时仍取完整 argv[0]：不得回退到被截断的首 token', () => {
  // 不传期望路径时，首个 token 会把路径截断——这正是相对基线的回退。
  assert.equal(processExecutablePath(`${SPACED_EXPECTED} --show`), '/Applications/My');
  // 已知期望路径（前缀 + 参数边界）→ 完整 argv[0] → 命中 exact。
  assert.equal(processExecutablePath(`${SPACED_EXPECTED} --show`, SPACED_EXPECTED), SPACED_EXPECTED);
  assert.equal(
    classifyExecutableMatch(processExecutablePath(`${SPACED_EXPECTED} --show`, SPACED_EXPECTED), SPACED_EXPECTED),
    'exact',
  );
  // AppTranslocation 前缀被换掉时用 app bundle 尾部定位 argv[0] 的结尾，同样不截断。
  assert.equal(
    processExecutablePath(`${SPACED_TRANSLOCATED} --show`, SPACED_EXPECTED),
    SPACED_TRANSLOCATED,
  );
  assert.equal(
    classifyExecutableMatch(processExecutablePath(`${SPACED_TRANSLOCATED} --show`, SPACED_EXPECTED), SPACED_EXPECTED),
    'app-translocation',
  );
  // 含空格路径下的同名副本仍不得算命中（不因放宽切分而变宽）。
  assert.equal(
    classifyExecutableMatch(
      processExecutablePath('/Users/me/My Builds/TokenLedger.app/Contents/MacOS/tokenledger --show', SPACED_EXPECTED),
      SPACED_EXPECTED,
    ),
    null,
  );
});

test('native 探针的显式路径优先于 ps 命令行解析，ps 行仍作兜底', () => {
  assert.equal(
    processRecordPath({ pid: 42, command: SPACED_TRANSLOCATED, path: SPACED_TRANSLOCATED }, SPACED_EXPECTED),
    SPACED_TRANSLOCATED,
  );
  assert.equal(
    processRecordPath({ pid: 43, command: `${SPACED_EXPECTED} --show` }, SPACED_EXPECTED),
    SPACED_EXPECTED,
  );
  assert.equal(
    processRecordPath({ pid: 44, command: SPACED_TRANSLOCATED }, SPACED_EXPECTED),
    SPACED_TRANSLOCATED,
  );
});

test('参数切分不会把含空格路径的片段当成参数', () => {
  assert.deepEqual(extractCommandArguments(`${SPACED_EXPECTED} --show`, SPACED_EXPECTED), ['--show']);
  assert.deepEqual(extractCommandArguments(`${SPACED_TRANSLOCATED} --minimized`, SPACED_TRANSLOCATED), ['--minimized']);
  assert.deepEqual(extractCommandArguments(SPACED_EXPECTED, SPACED_EXPECTED), []);
  assert.deepEqual(extractCommandArguments('/usr/bin/other --minimized'), ['--minimized']);
});

test('attach 断言语义与 app 一致：--show 优先于 --minimized（对照 should_start_minimized）', () => {
  // app 侧 `src-tauri/src/lib.rs` 的 `should_start_minimized` 是 `--show` 胜，Rust 用例
  // `explicit_show_wins_when_minimized_is_also_present` 锁同一口径；探针不得给出相反判定。
  assert.equal(
    attachVisibilityExpectation(`${EXPECTED_EXECUTABLE} --minimized --show`, EXPECTED_EXECUTABLE),
    'visible',
  );
  assert.equal(
    attachVisibilityExpectation(`${EXPECTED_EXECUTABLE} --show --minimized`, EXPECTED_EXECUTABLE),
    'visible',
  );
  assert.equal(attachVisibilityExpectation(`${EXPECTED_EXECUTABLE} --minimized`, EXPECTED_EXECUTABLE), 'minimized');
  assert.equal(attachVisibilityExpectation(`${EXPECTED_EXECUTABLE} --show`, EXPECTED_EXECUTABLE), 'visible');
  assert.equal(attachVisibilityExpectation(EXPECTED_EXECUTABLE, EXPECTED_EXECUTABLE), null);
  assert.deepEqual(attachAssertions('visible', {}), ['startup-args:--show']);
  assert.deepEqual(attachAssertions('minimized', {}), ['startup-args:--minimized']);
  // 与 app 同口径后，两个 flag 都在的实例不再与 `--require-visible` 冲突（它本就是可见的）。
  assert.deepEqual(
    attachAssertions(
      attachVisibilityExpectation(`${EXPECTED_EXECUTABLE} --minimized --show`, EXPECTED_EXECUTABLE),
      { requireVisible: true },
    ),
    ['startup-args:--show', '--require-visible'],
  );
});

test('attach 模式按被附着实例自身的启动参数选择断言，不启动、不清理', () => {
  assert.equal(attachVisibilityExpectation(`${EXPECTED_EXECUTABLE} --minimized`, EXPECTED_EXECUTABLE), 'minimized');
  assert.equal(attachVisibilityExpectation(`${EXPECTED_EXECUTABLE} --show`, EXPECTED_EXECUTABLE), 'visible');
  assert.equal(attachVisibilityExpectation(EXPECTED_EXECUTABLE, EXPECTED_EXECUTABLE), null);
  assert.equal(attachVisibilityExpectation(`${SPACED_EXPECTED} --show`, SPACED_EXPECTED), 'visible');

  const body = functionBody(SCRIPT_SOURCE(), 'runAttachProbe');
  assert.ok(body.length > 0, '必须存在 runAttachProbe');
  assert.doesNotMatch(body, /spawn\(\s*'open'/u, 'attach 模式不得启动实例');
  assert.doesNotMatch(body, /process\.kill\(/u, 'attach 模式不得清理实例');
  assert.match(body, /--minimized/u, 'attach 模式仍要保留 --minimized 的零窗口断言');
  assert.match(body, /1024/u, 'attach 模式仍要保留 --show 的尺寸断言');
});

test('--wait-ms 默认仍是 5000，显式传值只改等待窗口', () => {
  const defaults = parseArguments([]);

  assert.equal(defaults.waitMs, 5000);
  assert.equal(defaults.attach, false);
  assert.equal(defaults.requireActive, false);
  assert.equal(defaults.checkSingleInstance, false);
  assert.equal(defaults.checkReopen, false);
  assert.equal(defaults.requireVisible, false);
  assert.equal(parseArguments(['--wait-ms', '180000']).waitMs, 180000);
  assert.equal(parseArguments(['--wait-ms', '1']).waitMs, 1);
  // 与既有参数共存时互不干扰。
  const combined = parseArguments(['--require-active', '--wait-ms', '60000', '--attach']);
  assert.equal(combined.waitMs, 60000);
  assert.equal(combined.requireActive, true);
  assert.equal(combined.attach, true);
});

test('--attach / --no-launch 都开附着模式，非法 --wait-ms 与未知参数一律报错', () => {
  assert.equal(parseArguments(['--attach']).attach, true);
  assert.equal(parseArguments(['--no-launch']).attach, true);
  assert.throws(() => parseArguments(['--wait-ms', '5s']), /--wait-ms/u);
  assert.throws(() => parseArguments(['--wait-ms']), /--wait-ms/u);
  assert.throws(() => parseArguments(['--wait-ms', '0']), /--wait-ms/u);
  assert.throws(() => parseArguments(['--wait-ms', '3600001']), /--wait-ms/u);
  assert.throws(() => parseWaitMs(''), /--wait-ms/u);
  assert.throws(() => parseArguments(['--nope']), /unknown argument/u);
});

test('process match 诊断行在等待动作之前打印，且 exact 也要打印', () => {
  assert.equal(
    formatProcessMatch({ pid: 42, kind: 'exact', path: SPACED_EXPECTED }),
    `process match: pid=42 kind=exact path=${SPACED_EXPECTED}`,
  );
  assert.equal(
    formatProcessMatch({ pid: 42, kind: 'app-translocation', path: SPACED_TRANSLOCATED }, 'rebound'),
    `process match (rebound): pid=42 kind=app-translocation path=${SPACED_TRANSLOCATED}`,
  );

  const body = functionBody(SCRIPT_SOURCE(), 'waitForPid');
  assert.match(body, /console\.log\(formatProcessMatch\(match\)\)/u, '命中即打印，不得只在非 exact 时打印');
  assert.doesNotMatch(body, /kind !== 'exact'/u, 'exact 命中被静默会让人读不到 kind');
});

test('attach 模式的超时诊断说明它不启动也不清理实例', () => {
  const message = describeMissingProcess(EXPECTED_EXECUTABLE, { source: 'native', records: [], matches: [] }, 1000, {
    attach: true,
  });

  assert.match(message, /within 1000ms/u);
  assert.match(message, /attach/u);
  assert.match(message, /不启动、不清理/u);
});

// --- JEID-76 §7：attach 必须有生效断言；启动参数口径必须真的可达 -------------------

const NATIVE_RECORDS = [
  { pid: 42, command: EXPECTED_EXECUTABLE, path: EXPECTED_EXECUTABLE },
  { pid: 7, command: '/usr/sbin/cupsd', path: '/usr/sbin/cupsd' },
];

const MAIN_WINDOW = { name: 'TokenLedger', layer: 0, x: 40, y: 50, width: 1280, height: 860 };

// 窗口快照固定值；`probeWindows` 的返回形状（含 frontmost 解析字段）。
function windowsFixture({ count = 1, main = MAIN_WINDOW, frontmost = '42|TokenLedger|active=true', pid = 42 } = {}) {
  return { ...parseFrontmostState(frontmost, pid), count, main, wallpaper: null, windows: main ? [main] : [] };
}

// 只提供 attach 探针需要的外部依赖：进程枚举、ps 命令行、窗口读取、等待与输出。
function attachDeps({ records = NATIVE_RECORDS, commandRecords = [], windows = windowsFixture(), logs = [] } = {}) {
  return {
    listProcesses: () => ({
      source: 'native',
      records,
      matches: records.map((record) => ({
        pid: record.pid, path: record.path, command: record.command, kind: 'exact',
      })),
    }),
    commandRecords: () => {
      if (commandRecords instanceof Error) throw commandRecords;
      return commandRecords;
    },
    readWindows: () => windows,
    warmUp: () => {},
    wait: async () => {},
    log: (line) => logs.push(String(line)),
    logs,
  };
}

function attachOptions(overrides = {}) {
  return { waitMs: 5000, requireVisible: false, requireActive: false, ...overrides };
}

function assertNoPassLine(logs) {
  assert.equal(logs.filter((line) => /passed/u.test(line)).length, 0, `不得出现 passed 绿灯：${logs.join(' | ')}`);
}

test('native 记录 + ps 命令行按 pid 关联：attach 的启动参数口径在 native 生效时仍可达', () => {
  const merged = mergeProcessRecords(NATIVE_RECORDS, [
    { pid: 42, command: `${EXPECTED_EXECUTABLE} --show` },
    { pid: 7, command: '/usr/sbin/cupsd' },
  ]);

  // 路径以 native 为准（无 argv 拼接歧义），命令行以 ps 为准（含启动参数）。
  assert.deepEqual(merged[0], {
    pid: 42,
    path: EXPECTED_EXECUTABLE,
    command: `${EXPECTED_EXECUTABLE} --show`,
  });
  assert.equal(attachVisibilityExpectation(merged[0].command, merged[0].path), 'visible');

  // ps 里没有该 pid（不可用/被过滤）时不得凭空造出启动参数。
  const withoutPs = mergeProcessRecords(NATIVE_RECORDS, []);
  assert.equal(attachVisibilityExpectation(withoutPs[0].command, withoutPs[0].path), null);

  // 含空格路径 + 前置包装器：按 pid 合并后仍不截断，`--minimized` 同样能识别。
  const spacedPaths = [{ pid: 9, command: SPACED_EXPECTED, path: SPACED_EXPECTED }];
  const [spacedMerged] = mergeProcessRecords(spacedPaths, [
    { pid: 9, command: `/usr/bin/arch -arm64 ${SPACED_EXPECTED} --minimized` },
  ]);
  assert.equal(spacedMerged.path, SPACED_EXPECTED);
  assert.equal(attachVisibilityExpectation(spacedMerged.command, spacedMerged.path), 'minimized');
});

test('attach 无任何生效断言时必须硬失败，不得出 expectation=none 绿灯', async () => {
  const deps = attachDeps({ commandRecords: [] });

  await assert.rejects(() => runAttachProbe('/Applications/Fake.app', attachOptions(), deps), /no effective assertion/u);
  assertNoPassLine(deps.logs);

  // ps 不可用（抛错）与 ps 里没有该 pid 同属「拿不到启动参数」，结论一致。
  const psDown = attachDeps({ commandRecords: new Error('ps unavailable') });
  await assert.rejects(
    () => runAttachProbe('/Applications/Fake.app', attachOptions(), psDown),
    /no effective assertion/u,
  );
  assertNoPassLine(psDown.logs);

  assert.deepEqual(attachAssertions(null, {}), []);
  assert.equal(ATTACH_NO_ASSERTION_ERROR.includes('passed'), false);
});

test('attach 摘要行与 PASS 行只写实际生效的断言，且每条都被真的执行', async () => {
  // 启动参数口径可达：native 供路径、ps 说实例是用 --show 起的。
  const visible = attachDeps({ commandRecords: [{ pid: 42, command: `${EXPECTED_EXECUTABLE} --show` }] });
  await runAttachProbe('/Applications/Fake.app', attachOptions(), visible);
  assert.match(visible.logs[0], /assertions=startup-args:--show/u);
  assert.doesNotMatch(visible.logs[0], /expectation=none/u);
  assert.equal(visible.logs.at(-1), 'macOS native window smoke passed (attach, assertions=startup-args:--show)');

  // 没有启动参数时，`--require-visible` 是唯一生效的断言，也必须写出来。
  const requireVisible = attachDeps({ commandRecords: [] });
  await runAttachProbe('/Applications/Fake.app', attachOptions({ requireVisible: true }), requireVisible);
  assert.equal(requireVisible.logs.at(-1), 'macOS native window smoke passed (attach, assertions=--require-visible)');

  assert.deepEqual(attachAssertions('minimized', {}), ['startup-args:--minimized']);
  assert.deepEqual(attachAssertions(null, { requireActive: true }), ['--require-active']);

  // 两个启动参数同时在场时按 app 语义 `--show` 胜：摘要行不得写成 startup-args:--minimized。
  const bothFlags = attachDeps({
    commandRecords: [{ pid: 42, command: `${EXPECTED_EXECUTABLE} --minimized --show` }],
  });
  await runAttachProbe('/Applications/Fake.app', attachOptions({ requireVisible: true }), bothFlags);
  assert.match(bothFlags.logs[0], /assertions=startup-args:--show\+--require-visible/u);
  assert.equal(
    bothFlags.logs.at(-1),
    'macOS native window smoke passed (attach, assertions=startup-args:--show+--require-visible)',
  );

  // 列出的断言必须真被执行：--minimized 却看到主窗口 → 失败。
  const minimized = attachDeps({ commandRecords: [{ pid: 42, command: `${EXPECTED_EXECUTABLE} --minimized` }] });
  await assert.rejects(
    () => runAttachProbe('/Applications/Fake.app', attachOptions(), minimized),
    /no on-screen main window/u,
  );
  assertNoPassLine(minimized.logs);

  // --minimized 与 --require-visible 互斥：同时给等于其中一条被静默忽略。
  const conflicting = attachDeps({ commandRecords: [{ pid: 42, command: `${EXPECTED_EXECUTABLE} --minimized` }] });
  await assert.rejects(
    () => runAttachProbe('/Applications/Fake.app', attachOptions({ requireVisible: true }), conflicting),
    /conflicts with the attached instance --minimized/u,
  );
  assertNoPassLine(conflicting.logs);

  // --require-active 是真的断言：前台是别的 app 时失败。
  const inactive = attachDeps({
    commandRecords: [{ pid: 42, command: `${EXPECTED_EXECUTABLE} --show` }],
    windows: windowsFixture({ frontmost: '1236|Microsoft Edge|active=true' }),
  });
  await assert.rejects(
    () => runAttachProbe('/Applications/Fake.app', attachOptions({ requireActive: true }), inactive),
    /frontmost/u,
  );
  assertNoPassLine(inactive.logs);
});

test('waitForPid 超时硬失败：抛错、不打印 passed、错误里带实际等待耗时', async () => {
  const observation = {
    source: 'native',
    records: [{ pid: 7, command: '/usr/sbin/cupsd', path: '/usr/sbin/cupsd' }],
    matches: [],
  };
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(String(line));
  let clock = 0;
  try {
    await assert.rejects(
      waitForPid(EXPECTED_EXECUTABLE, new Set(), 250, {
        listProcesses: () => observation,
        warmUp: () => {},
        wait: async () => { clock += 100; },
        now: () => clock,
      }),
      /did not appear within 300ms/u,
    );
  } finally {
    console.log = originalLog;
  }
  assertNoPassLine(logs);
});

test('--attach 与 --check-single-instance / --check-reopen 互斥：显式报错，不静默降级', () => {
  for (const argv of [
    ['--attach', '--check-single-instance'],
    ['--check-single-instance', '--attach'],
    ['--attach', '--check-reopen'],
    ['--no-launch', '--check-reopen'],
    ['--attach', '--check-single-instance', '--check-reopen'],
  ]) {
    assert.throws(() => parseArguments(argv), /--attach cannot be combined with/u, argv.join(' '));
  }
  // 单独使用不受影响。
  assert.equal(parseArguments(['--check-single-instance']).checkSingleInstance, true);
  assert.equal(parseArguments(['--check-reopen', '--require-visible']).checkReopen, true);
});

// --- JEID-76 §8：相对基线的包装器收窄（`/usr/bin/arch -arm64 <app>`）----------------

const ROSETTA_WRAPPED = `/usr/bin/arch -arm64 ${EXPECTED_EXECUTABLE} --show`;

test('前置包装器（Rosetta /usr/bin/arch -arm64）不再窄化：仍按应用路径命中', () => {
  assert.equal(stripLauncherWrapper(ROSETTA_WRAPPED), `${EXPECTED_EXECUTABLE} --show`);
  assert.equal(processExecutablePath(ROSETTA_WRAPPED, EXPECTED_EXECUTABLE), EXPECTED_EXECUTABLE);
  assert.equal(
    classifyExecutableMatch(processExecutablePath(ROSETTA_WRAPPED, EXPECTED_EXECUTABLE), EXPECTED_EXECUTABLE),
    'exact',
  );
  // 包装器 + 含空格路径。
  assert.equal(
    processExecutablePath(`/usr/bin/arch -arm64 ${SPACED_EXPECTED} --show`, SPACED_EXPECTED),
    SPACED_EXPECTED,
  );
  // 包装器 + AppTranslocation（隔离场景下前缀被换掉）。
  assert.equal(
    classifyExecutableMatch(
      processExecutablePath(`/usr/bin/arch -arm64 ${TRANSLOCATED_EXECUTABLE} --minimized`, EXPECTED_EXECUTABLE),
      EXPECTED_EXECUTABLE,
    ),
    'app-translocation',
  );
  // 包装器下也要取到真正的启动参数（attach 断言口径依赖它）。
  assert.deepEqual(extractCommandArguments(ROSETTA_WRAPPED, EXPECTED_EXECUTABLE), ['--show']);
});

test('包装器容忍不放宽负例：另一份副本、非 argv[0] 处的同名路径仍不命中', () => {
  assert.equal(
    classifyExecutableMatch(
      processExecutablePath(`/usr/bin/arch -arm64 /Users/me/Builds/TokenLedger.app/Contents/MacOS/tokenledger`, EXPECTED_EXECUTABLE),
      EXPECTED_EXECUTABLE,
    ),
    null,
  );
  assert.equal(
    classifyExecutableMatch(
      processExecutablePath(`/usr/bin/arch -arm64 /Users/me/Builds/TokenLedger.app/Contents/MacOS/tokenledger --show`, EXPECTED_EXECUTABLE),
      EXPECTED_EXECUTABLE,
    ),
    null,
  );
  // 期望路径只出现在参数里（不是 argv[0]）不算命中。
  assert.equal(
    classifyExecutableMatch(
      processExecutablePath(`/usr/bin/other --app ${EXPECTED_EXECUTABLE}`, EXPECTED_EXECUTABLE),
      EXPECTED_EXECUTABLE,
    ),
    null,
  );
  // 未知的白名单外包装器不享受剥离：行里出现期望路径也仍是 null（不放宽）。
  assert.equal(
    classifyExecutableMatch(
      processExecutablePath(`/usr/bin/someotherwrapper ${EXPECTED_EXECUTABLE}`, EXPECTED_EXECUTABLE),
      EXPECTED_EXECUTABLE,
    ),
    null,
  );
  // 没有期望路径时保持旧行为（首个 token），不得因剥离而改变。
  assert.equal(processExecutablePath(`${SPACED_EXPECTED} --show`), '/Applications/My');
  assert.equal(processExecutablePath('/usr/bin/arch -arm64 /Applications/other'), '/usr/bin/arch');
});

test('darwin 端到端：命不中的 attach 探针必须退出码 1 且不打印 passed', () => {
  const root = mkdtempSync(join(tmpdir(), 'tl-probe-darwin-'));
  try {
    const app = join(root, 'Fake.app');
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(app, 'Contents', 'MacOS', 'tokenledger'), '');
    const platformPatch = join(root, 'darwin-platform.cjs');
    writeFileSync(platformPatch, "Object.defineProperty(process, 'platform', { value: 'darwin' });\n", 'utf8');

    const result = spawnSync(
      process.execPath,
      ['--require', platformPatch, SCRIPT_PATH, '--attach', '--wait-ms', '1', '--app', app],
      { encoding: 'utf8', timeout: 60000 },
    );

    assert.equal(result.status, 1, `stdout=${result.stdout} stderr=${result.stderr}`);
    assert.doesNotMatch(result.stdout, /passed/u);
    // 等待窗口用尽（有进程枚举）或探针本身不可用，两条路都必须硬失败。
    assert.match(`${result.stdout}${result.stderr}`, /did not appear within|process inspection unavailable/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
