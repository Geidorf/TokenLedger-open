import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'increment-version.mjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenledger-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'src-tauri'));
  fs.mkdirSync(path.join(root, 'apps/android/app'), { recursive: true });
  fs.copyFileSync(path.join(path.dirname(source), 'check-version.mjs'), path.join(root, 'scripts/check-version.mjs'));
  fs.writeFileSync(path.join(root, 'apps/android/app/build.gradle.kts'), 'val appVersion = readPackageVersion()\nversionName = appVersion\nTokenLedger_Android_${appVersion}_debug.apk');
  fs.copyFileSync(source, path.join(root, 'scripts/increment-version.mjs'));
  const files = {
    'package.json': JSON.stringify({ version: '1.2.77', scripts: { 'release:bump': 'node scripts/increment-version.mjs --explicit-release' } }),
    'package-lock.json': JSON.stringify({ version: '1.2.77', packages: { '': { version: '1.2.77' } } }),
    'src-tauri/Cargo.toml': '[package]\nname = "tokenledger"\nversion = "1.2.77"\n',
    'src-tauri/Cargo.lock': '[[package]]\nname = "dependency"\nversion = "3.4.5"\n\n[[package]]\nname = "tokenledger"\nversion = "1.2.77"\n',
    'src-tauri/tauri.conf.json': JSON.stringify({ version: '1.2.77' }),
    'src-tauri/tauri.legacy.conf.json': JSON.stringify({ version: '1.2.77' }),
  };
  for (const [file, contents] of Object.entries(files)) fs.writeFileSync(path.join(root, file), contents);
  return { root, files, run: args => spawnSync(process.execPath, [path.join(root, 'scripts/increment-version.mjs'), ...args], { encoding: 'utf8', timeout: 10000 }) };
}
function assertUnchanged(root, files) {
  for (const [file, contents] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), contents, file);
}
test('explicit major target synchronizes all versions without changing dependencies', t => {
  const { root, run } = fixture(t);
  const result = run(['--explicit-release', '--version', '2.0.0']);
  assert.equal(result.status, 0, result.stderr);
  for (const file of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.legacy.conf.json']) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).version, '2.0.0');
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages[''].version, '2.0.0');
  assert.match(fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8'), /version = "2.0.0"/);
  const lock = fs.readFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'utf8');
  assert.match(lock, /name = "tokenledger"\nversion = "2.0.0"/);
  assert.match(lock, /name = "dependency"\nversion = "3.4.5"/);
});
test('default explicit release still increments patch', t => {
  const { root, run } = fixture(t);
  assert.equal(run(['--explicit-release']).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, '1.2.78');
});
for (const args of [[], ['--version', '2.0.0'], ['--explicit-release', '--version'], ['--explicit-release', '--version', '2.00.0'], ['--explicit-release', '--version', '1.2.77'], ['--explicit-release', '--version', '1.1.99'], ['--unexpected', '--explicit-release'], ['--explicit-release', '--version', '2.0.0', '--version', '3.0.0']]) {
  test(`invalid or unauthorized request leaves files unchanged: ${args.join(' ')}`, t => {
    const { root, files, run } = fixture(t);
    assert.notEqual(run(args).status, 0);
    assertUnchanged(root, files);
  });
}
test('missing Rust lock entry is rejected before changing any version', t => {
  const { root, files, run } = fixture(t);
  files['src-tauri/Cargo.lock'] = '[[package]]\nname = "dependency"\nversion = "3.4.5"\n';
  fs.writeFileSync(path.join(root, 'src-tauri/Cargo.lock'), files['src-tauri/Cargo.lock']);
  assert.notEqual(run(['--explicit-release', '--version', '2.0.0']).status, 0);
  assertUnchanged(root, files);
});

test('npm release entry forwards the major target and performs consistency checks', t => {
  const { root } = fixture(t);
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'release:bump', '--', '--version', '2.0.0'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Version check passed: 2\.0\.0/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, '2.0.0');
});
test('drifted Rust manifest is rejected without writes', t => {
  const { root, files, run } = fixture(t);
  files['src-tauri/Cargo.toml'] = files['src-tauri/Cargo.toml'].replace('1.2.77', '1.2.76');
  fs.writeFileSync(path.join(root, 'src-tauri/Cargo.toml'), files['src-tauri/Cargo.toml']);
  assert.notEqual(run(['--explicit-release', '--version', '2.0.0']).status, 0);
  assertUnchanged(root, files);
});

test('drifted Rust lock is rejected without writes', t => {
  const { root, files, run } = fixture(t);
  files['src-tauri/Cargo.lock'] = files['src-tauri/Cargo.lock'].replace('version = "1.2.77"', 'version = "1.2.76"');
  fs.writeFileSync(path.join(root, 'src-tauri/Cargo.lock'), files['src-tauri/Cargo.lock']);
  assert.notEqual(run(['--explicit-release', '--version', '2.0.0']).status, 0);
  assertUnchanged(root, files);
});
