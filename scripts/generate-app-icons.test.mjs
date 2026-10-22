import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ANDROID_SAFE_RADIUS,
  expectedOutputs,
  findDrift,
  parseMark,
  replaceOutputs,
} from './generate-app-icons.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..');
const SCRIPT = join(SCRIPT_DIR, 'generate-app-icons.mjs');
const SOURCE = join(ROOT, 'src/assets/brand/tokenledger-mark.svg');

function runGenerator(args = [], env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 300_000,
  });
}

function outputHashes(root = ROOT) {
  return new Map(expectedOutputs().map((path) => [
    path,
    createHash('sha256').update(readFileSync(join(root, path))).digest('hex'),
  ]));
}

function writeSource(root, source = readFileSync(SOURCE, 'utf8')) {
  const path = join(root, 'src/assets/brand/tokenledger-mark.svg');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function writeOutputSet(root, prefix) {
  for (const output of expectedOutputs()) {
    const path = join(root, output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${prefix}:${output}`);
  }
}

function resolveTauriScript() {
  const local = join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  if (existsSync(local)) return local;
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const shared = join(dirname(resolve(ROOT, result.stdout.trim())), 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  assert.equal(existsSync(shared), true, `找不到 Tauri CLI：${shared}`);
  return shared;
}

test('唯一 SVG 源提供路径、线宽、尺寸并满足 Android 圆形安全区', () => {
  const mark = parseMark(readFileSync(SOURCE, 'utf8'));
  assert.equal(mark.path, 'M5 5V19H19 M11 5H19 M11 12H17');
  assert.equal(mark.strokeWidth, 2.8);
  assert.equal(mark.size, 24);
  assert.ok(mark.inkRadius <= ANDROID_SAFE_RADIUS);
  assert.ok(Math.abs(mark.inkRadius - 32.77) < 0.01);
  assert.throws(
    () => parseMark('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M0 0H24V24"/></svg>'),
    /超出 Android 圆形安全区/,
  );
  assert.throws(
    () => parseMark('<svg viewBox="1 1 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6V18H18"/></svg>'),
    /必须从 0 0 开始/,
  );
});

test('修改唯一 SVG 源会驱动 TS、Kotlin 与矢量派生产物', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'tokenledger-icon-source-'));
  try {
    writeSource(fixture, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6V18H18 M12 6H18 M12 12H16"/></svg>\n');
    const result = runGenerator(['--root', fixture, '--tauri-cli', resolveTauriScript()]);
    assert.equal(result.status, 0, result.stderr);
    const ts = readFileSync(join(fixture, 'src/components/brand/tokenLedgerGeometry.ts'), 'utf8');
    const kotlin = readFileSync(join(fixture, 'apps/android/app/src/main/java/com/jeidorf/tokenledger/mobile/TokenLedgerBrand.kt'), 'utf8');
    const vector = readFileSync(join(fixture, 'apps/android/app/src/main/res/drawable/ic_launcher_foreground.xml'), 'utf8');
    for (const content of [ts, kotlin, vector]) {
      assert.match(content, /M6 6V18H18 M12 6H18 M12 12H16/);
      assert.match(content, /2\.4/);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('漂移检查能指出变化的派生文件', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'tokenledger-icon-drift-'));
  const stage = join(fixture, 'stage');
  const root = join(fixture, 'root');
  try {
    writeOutputSet(stage, 'same');
    writeOutputSet(root, 'same');
    assert.deepEqual(findDrift(stage, root), []);
    const changed = expectedOutputs()[3];
    writeFileSync(join(root, changed), 'changed');
    assert.deepEqual(findDrift(stage, root), [changed]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('旧文件已移入备份而新文件安装失败时完整回滚', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'tokenledger-icon-rollback-'));
  const stage = join(fixture, 'stage');
  const root = join(fixture, 'root');
  try {
    writeOutputSet(stage, 'new');
    writeOutputSet(root, 'old');
    assert.throws(() => replaceOutputs(stage, root, { failAfterBackupAt: 4 }), /备份第 4 个旧文件后中止/);
    for (const output of expectedOutputs()) {
      assert.equal(readFileSync(join(root, output), 'utf8'), `old:${output}`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('安装部分新文件后失败时完整回滚', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'tokenledger-icon-install-'));
  const stage = join(fixture, 'stage');
  const root = join(fixture, 'root');
  try {
    writeOutputSet(stage, 'new');
    writeOutputSet(root, 'old');
    assert.throws(() => replaceOutputs(stage, root, { failAfterInstallAt: 6 }), /安装第 6 个文件后中止/);
    for (const output of expectedOutputs()) {
      assert.equal(readFileSync(join(root, output), 'utf8'), `old:${output}`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('渲染器失败不改写任何目标', () => {
  const before = outputHashes();
  const result = runGenerator([], { TOKENLEDGER_ICON_FAIL_AFTER_RENDER: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /按测试要求在渲染后中止/);
  assert.deepEqual(outputHashes(), before);
});

test('真实渲染器非零退出时原产物不变', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'tokenledger-icon-renderer-fail-'));
  try {
    writeSource(fixture);
    writeOutputSet(fixture, 'old');
    const fakeCli = join(fixture, 'fake-tauri.js');
    writeFileSync(fakeCli, 'process.exit(3);\n');
    const before = outputHashes(fixture);
    const result = runGenerator(['--root', fixture, '--tauri-cli', fakeCli]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Tauri 图标渲染失败（退出码 3）/);
    assert.deepEqual(outputHashes(fixture), before);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('在临时目录重复生成字节稳定且 --check 通过', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'tokenledger-icon-repeat-'));
  try {
    writeSource(fixture);
    const args = ['--root', fixture, '--tauri-cli', resolveTauriScript()];
    const first = runGenerator(args);
    assert.equal(first.status, 0, first.stderr);
    const once = outputHashes(fixture);
    const second = runGenerator(args);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(outputHashes(fixture), once);
    const check = runGenerator(['--check', ...args]);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /品牌资源与唯一 SVG 源一致/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
