import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const git = process.platform === 'win32' ? 'git.exe' : 'git';
const androidFixtureEnv = {
  ...process.env,
  TOKENLEDGER_SUPABASE_URL: 'https://ci-fixture.supabase.co',
  TOKENLEDGER_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_ci_fixture',
};
const strictClippyEnv = {
  ...process.env,
  // objc 0.2 expands a legacy cfg(feature = "cargo-clippy") in the destination
  // crate. Declare that dependency-owned value while keeping every warning at
  // deny level.
  RUSTFLAGS: [
    process.env.RUSTFLAGS,
    '--check-cfg=cfg(feature,values("cargo-clippy"))',
  ].filter(Boolean).join(' '),
};

function trackedFiles() {
  return execFileSync(git, ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function fingerprint(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    return 'missing';
  }
  const stat = fs.lstatSync(absolutePath);
  const content = stat.isSymbolicLink()
    ? Buffer.from(fs.readlinkSync(absolutePath))
    : fs.readFileSync(absolutePath);
  return `${(stat.mode & 0o777).toString(8)}:${createHash('sha256').update(content).digest('hex')}`;
}

function snapshot() {
  return new Map(trackedFiles().map((file) => [file, fingerprint(file)]));
}

function changedTrackedFiles(before, after) {
  const files = new Set([...before.keys(), ...after.keys()]);
  return [...files].filter((file) => before.get(file) !== after.get(file)).sort();
}

const checks = [
  ['collaboration documents', process.execPath, ['scripts/check-docs.mjs']],
  ['tracked path length', npm, ['run', 'check:paths']],
  ['tracked path length tests', npm, ['run', 'test:paths']],
  ['version consistency', npm, ['run', 'version:check']],
  ['Android widget preview assets', npm, ['run', 'check:android:widget-previews']],
  ['TypeScript', npm, ['run', 'typecheck']],
  ['ESLint (react-hooks)', npm, ['run', 'lint']],
  ['frontend contracts', npm, ['run', 'test:frontend']],
  ['frontend production build', npm, ['run', 'build:web']],
  ['chart bundle budget', process.execPath, ['scripts/check-bundle-budget.mjs']],
  ['scan scale gate', process.execPath, ['scripts/run-scan-scale-gate.mjs']],
  ['release manifest tests', process.execPath, ['--test', 'scripts/release-manifest.test.mjs']],
  [
    'release trust and parser tests',
    npm,
    ['run', 'test:release-security'],
  ],
  ['Rust formatting', 'cargo', ['fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--check']],
  [
    'Rust clippy with warnings denied',
    'cargo',
    ['clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--', '-D', 'warnings'],
    strictClippyEnv,
  ],
  ['Rust tests', 'cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--', '--test-threads=1']],
  [
    'Android unit, lint, screenshot, debug and unsigned R8 gates',
    process.execPath,
    [
      'scripts/run-android-gradle.mjs',
      'testDebugUnitTest',
      ':app:testSupabaseClientKeyPolicy',
      'lintDebug',
      ':app:validateDebugScreenshotTest',
      'assembleDebug',
      'assembleRelease',
    ],
    androidFixtureEnv,
  ],
  ['Supabase empty-database, SQL, RLS, RPC and EXPLAIN gates', process.execPath, ['scripts/run-supabase-release-gate.mjs']],
  ['unstaged whitespace errors', git, ['diff', '--check']],
  ['staged whitespace errors', git, ['diff', '--cached', '--check']],
];

const before = snapshot();
let failure = null;

for (const [label, command, args, env = process.env] of checks) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
  });
  if (result.error || result.status !== 0) {
    failure = { label, result };
    break;
  }
}

const mutations = changedTrackedFiles(before, snapshot());
if (mutations.length > 0) {
  console.error('\nRelease checks modified tracked files:');
  for (const file of mutations) {
    console.error(`  - ${file}`);
  }
  process.exit(1);
}

if (failure) {
  if (failure.result.error) {
    console.error(`\n${failure.label} could not start: ${failure.result.error.message}`);
  } else {
    console.error(`\n${failure.label} failed with exit code ${failure.result.status}.`);
  }
  process.exit(failure.result.status || 1);
}

console.log('\nAll release checks passed; tracked files are unchanged.');
