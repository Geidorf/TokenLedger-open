import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function fail(message) {
  failures.push(message);
}

function expectEqual(label, actual, expected) {
  if (actual !== expected) {
    fail(`${label}: expected ${expected}, got ${actual}`);
  }
}

function matchVersion(relativePath, pattern, label) {
  const content = readText(relativePath);
  const match = content.match(pattern);
  if (!match) {
    fail(`${label}: version field was not found`);
    return null;
  }
  return match[1];
}

const failures = [];
const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');
const version = packageJson.version;

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`package.json version must be semantic, got ${version}`);
}

expectEqual('package-lock root version', packageLock.version, version);
expectEqual('package-lock packages[""].version', packageLock.packages?.['']?.version, version);
expectEqual(
  'src-tauri/Cargo.toml version',
  matchVersion('src-tauri/Cargo.toml', /^version\s*=\s*"([^"]+)"/m, 'Cargo.toml'),
  version
);
expectEqual(
  'src-tauri/Cargo.lock package version',
  matchVersion('src-tauri/Cargo.lock', /\[\[package\]\]\r?\nname = "tokenledger"\r?\nversion = "([^"]+)"/, 'Cargo.lock'),
  version
);
expectEqual('tauri.conf.json version', readJson('src-tauri/tauri.conf.json').version, version);
expectEqual(
  'tauri.legacy.conf.json version',
  readJson('src-tauri/tauri.legacy.conf.json').version,
  version
);

const androidGradle = readText('apps/android/app/build.gradle.kts');
if (!androidGradle.includes('val appVersion = readPackageVersion()')) {
  fail('Android build must read versionName from the root package.json');
}
if (!androidGradle.includes('versionName = appVersion')) {
  fail('Android build must assign versionName from appVersion');
}
if (!androidGradle.includes('TokenLedger_Android_${appVersion}_debug.apk')) {
  fail('Android debug build must produce a versioned APK name');
}

if (failures.length > 0) {
  console.error('Version check failed:');
  for (const item of failures) {
    console.error(`- ${item}`);
  }
  process.exit(1);
}

console.log(`Version check passed: ${version}`);
