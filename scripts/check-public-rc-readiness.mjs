import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertAllowedSupabaseClientKey } from './supabase-client-key.mjs';
import { assertReleaseLedgerForChannel } from './m10-public-rc-exit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  throw new Error(message);
}

function requireValue(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`required release variable ${name} is missing`);
  }
  return value;
}

function requireExactValue(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    fail(`required release variable ${name} is missing`);
  }
  return value;
}

function requireFile(name) {
  const value = requireValue(name);
  if (!fs.statSync(value, { throwIfNoEntry: false })?.isFile()) {
    fail(`${name} must point to a readable file`);
  }
  return value;
}

function parseArgs(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      fail(`invalid argument ${flag ?? '<missing>'}`);
    }
    options.set(flag.slice(2), value);
  }
  return options;
}

function assertPublicConfiguration() {
  const url = new URL(requireValue('TOKENLEDGER_SUPABASE_URL'));
  if (url.protocol !== 'https:' || !url.hostname) {
    fail('TOKENLEDGER_SUPABASE_URL must be an HTTPS production endpoint');
  }
  const key = requireExactValue('TOKENLEDGER_SUPABASE_PUBLISHABLE_KEY');
  assertAllowedSupabaseClientKey(key, 'TOKENLEDGER_SUPABASE_PUBLISHABLE_KEY');
  for (const forbidden of [
    'SUPABASE_SERVICE_ROLE_KEY',
    'TOKENLEDGER_SUPABASE_SERVICE_ROLE_KEY',
    'TOKENLEDGER_SUPABASE_SECRET_KEY',
  ]) {
    if (process.env[forbidden]?.trim()) {
      fail(`${forbidden} must not be present in a client release job`);
    }
  }
}

function assertRepositoryState(channel) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (!version) {
    fail('repository version missing in package.json');
  }
  // 正式发布只能由 tag 驱动：tag 必须存在且等于 v<package.json version>。
  // GitHub Actions 里由 GITHUB_REF_NAME 提供；本地演练需显式设置
  // TOKENLEDGER_RELEASE_TAG，缺失即失败，而不是静默放过。
  const tag = process.env.GITHUB_REF_NAME || process.env.TOKENLEDGER_RELEASE_TAG;
  if (tag !== `v${version}`) {
    fail(
      `release tag must be v${version}; got ${tag || '<missing>'}`
      + ' (set TOKENLEDGER_RELEASE_TAG when running outside GitHub Actions)',
    );
  }
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    fail('release source commit could not be resolved');
  }
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (dirty) {
    fail('formal release checkout must be clean');
  }
}

function assertAndroid() {
  requireFile('TOKENLEDGER_ANDROID_KEYSTORE_PATH');
  for (const name of [
    'TOKENLEDGER_ANDROID_KEYSTORE_PASSWORD',
    'TOKENLEDGER_ANDROID_KEY_ALIAS',
    'TOKENLEDGER_ANDROID_KEY_PASSWORD',
  ]) {
    requireValue(name);
  }
  const expectedDigest = requireValue('TOKENLEDGER_ANDROID_SIGNING_CERT_SHA256')
    .replace(/^sha256:/i, '')
    .replaceAll(':', '')
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedDigest)) {
    fail('TOKENLEDGER_ANDROID_SIGNING_CERT_SHA256 must be a SHA-256 certificate fingerprint');
  }
  const gradle = fs.readFileSync(path.join(root, 'apps/android/app/build.gradle.kts'), 'utf8');
  if (!gradle.includes('applicationId = "com.jeidorf.tokenledger.mobile"')) {
    fail('production Android applicationId changed unexpectedly');
  }
  if (!gradle.includes('applicationIdSuffix = ".debug"')) {
    fail('Android debug applicationId isolation is missing');
  }
}

function assertMacos() {
  for (const name of [
    'APPLE_CERTIFICATE',
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_SIGNING_IDENTITY',
    'APPLE_ID',
    'APPLE_PASSWORD',
    'APPLE_TEAM_ID',
  ]) {
    requireValue(name);
  }
}

function assertWindows() {
  requireFile('TOKENLEDGER_WINDOWS_CERTIFICATE_PATH');
  for (const name of [
    'TOKENLEDGER_WINDOWS_CERTIFICATE_PASSWORD',
    'TOKENLEDGER_WINDOWS_SIGNING_IDENTITY',
  ]) {
    requireValue(name);
  }
  const timestampUrl = new URL(requireValue('TOKENLEDGER_WINDOWS_TIMESTAMP_URL'));
  if (timestampUrl.protocol !== 'https:') {
    fail('TOKENLEDGER_WINDOWS_TIMESTAMP_URL must use HTTPS');
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  const channel = options.get('channel');
  const platform = options.get('platform');
  if (!channel || !platform) {
    fail('--channel and --platform are required');
  }
  assertRepositoryState(channel);
  // Closed tasks move to docs/TASKS-archive.md (T10.211); the M10 exit reads both files.
  const archivePath = path.join(root, 'docs', 'TASKS-archive.md');
  assertReleaseLedgerForChannel(
    channel,
    fs.readFileSync(path.join(root, 'docs', 'TASKS.md'), 'utf8'),
    fs.existsSync(archivePath) ? fs.readFileSync(archivePath, 'utf8') : null,
  );
  assertPublicConfiguration();
  if (platform === 'android') {
    assertAndroid();
  } else if (platform === 'macos') {
    assertMacos();
  } else if (platform === 'windows') {
    assertWindows();
  } else if (platform !== 'common') {
    fail(`unsupported platform ${platform}`);
  }
  console.log(`${channel} ${platform} release prerequisites are complete.`);
} catch (error) {
  console.error(`Formal release blocked: ${error.message}`);
  process.exit(1);
}
