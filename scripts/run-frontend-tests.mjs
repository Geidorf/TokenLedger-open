import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenledger-frontend-tests-'));
const bundledTest = path.join(temporaryDirectory, 'frontend-contracts.test.mjs');

try {
  await build({
    entryPoints: [path.join(root, 'tests/frontend-contracts.test.mjs')],
    outfile: bundledTest,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    sourcemap: 'inline',
    logLevel: 'silent',
  });

  const result = spawnSync(process.execPath, ['--test', bundledTest, path.join(root, 'tests/design-tokens.test.mjs'), path.join(root, 'tests/tauri-command-acl.test.mjs')], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    console.error(`Frontend contract tests could not start: ${result.error.message}`);
    process.exitCode = 1;
  } else if (result.status !== 0) {
    process.exitCode = result.status || 1;
  }
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
