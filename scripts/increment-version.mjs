import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
if (!args.includes('--explicit-release')) {
  console.error(
    'Refusing to change versions implicitly. Use "npm run release:bump" as an explicit release step.',
  );
  process.exit(1);
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function writeText(relativePath, content) {
  fs.writeFileSync(path.join(root, relativePath), content, 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function writeJson(relativePath, data) {
  writeText(relativePath, JSON.stringify(data, null, 2) + '\n');
}

// 1. Read package.json version
const packageJsonPath = 'package.json';
const packageJson = readJson(packageJsonPath);
const oldVersion = packageJson.version;

// 2. Preserve the patch default; an explicitly selected release can target a new major.
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?$/;
const match = oldVersion.match(versionPattern);
const targetIndex = args.indexOf('--version');
const unknownArgs = args.filter((arg, index) =>
  arg !== '--explicit-release' && arg !== '--version' && !(targetIndex >= 0 && index === targetIndex + 1));
if (!match || unknownArgs.length || args.filter(arg => arg === '--version').length > 1) {
  console.error('Error: Invalid current version or arguments. Use --explicit-release [--version X.Y.Z].');
  process.exit(1);
}
const newVersion = targetIndex >= 0
  ? args[targetIndex + 1]
  : `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4] ? `-${match[4]}` : ''}`;
const target = newVersion?.match(versionPattern);
if (!target || target.slice(1, 4).some(value => !Number.isSafeInteger(Number(value)))
  || target[4]?.split('.').some(value => /^0\d+$/.test(value))) {
  console.error('Error: --version requires a valid semantic version.');
  process.exit(1);
}
const oldCore = match.slice(1, 4).map(Number);
const newCore = target.slice(1, 4).map(Number);
const firstDifference = newCore.findIndex((value, index) => value !== oldCore[index]);
if (firstDifference < 0 || newCore[firstDifference] < oldCore[firstDifference]) {
  console.error('Error: Release version must increase the numeric version.');
  process.exit(1);
}
// Preflight all version files before making any changes.
const cargoTomlPath = 'src-tauri/Cargo.toml';
let cargoToml = readText(cargoTomlPath);
const cargoVersionPattern = /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m;
const cargoLockPath = 'src-tauri/Cargo.lock';
let cargoLock = readText(cargoLockPath);
const cargoLockPattern = /(\[\[package\]\]\r?\nname = "tokenledger"\r?\nversion = ")[^"]+(")/;
if (!cargoVersionPattern.test(cargoToml) || !cargoLockPattern.test(cargoLock)) {
  console.error('Error: Rust package version fields were not found.');
  process.exit(1);
}
for (const file of ['package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.legacy.conf.json']) {
  if (fs.existsSync(path.join(root, file))) readJson(file);
}

function checkVersions() {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/check-version.mjs')], {
    cwd: root, stdio: 'inherit', timeout: 10000,
  });
  if (result.error || result.status !== 0) {
    console.error('Error: Version consistency check failed.');
    process.exit(1);
  }
}
checkVersions();

console.log(`Explicitly incrementing release version: ${oldVersion} -> ${newVersion}`);

// 3. Update package.json
packageJson.version = newVersion;
writeJson(packageJsonPath, packageJson);

// 4. Update package-lock.json
const packageLockPath = 'package-lock.json';
if (fs.existsSync(path.join(root, packageLockPath))) {
  const packageLock = readJson(packageLockPath);
  packageLock.version = newVersion;
  if (packageLock.packages && packageLock.packages['']) {
    packageLock.packages[''].version = newVersion;
  }
  writeJson(packageLockPath, packageLock);
}

// 5. Update the Rust package and its lock entry without resolving dependencies.
writeText(cargoTomlPath, cargoToml.replace(cargoVersionPattern, `$1${newVersion}$2`));
writeText(cargoLockPath, cargoLock.replace(cargoLockPattern, `$1${newVersion}$2`));

// 6. Update tauri.conf.json
const tauriConfPath = 'src-tauri/tauri.conf.json';
if (fs.existsSync(path.join(root, tauriConfPath))) {
  const tauriConf = readJson(tauriConfPath);
  tauriConf.version = newVersion;
  writeJson(tauriConfPath, tauriConf);
}

// 7. Update tauri.legacy.conf.json
const tauriLegacyConfPath = 'src-tauri/tauri.legacy.conf.json';
if (fs.existsSync(path.join(root, tauriLegacyConfPath))) {
  const tauriLegacyConf = readJson(tauriLegacyConfPath);
  tauriLegacyConf.version = newVersion;
  writeJson(tauriLegacyConfPath, tauriLegacyConf);
}

checkVersions();
console.log('Version synchronization complete.');
