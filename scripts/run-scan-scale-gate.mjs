import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontendDist = resolve(projectRoot, 'dist');
const createdFrontendDist = !existsSync(frontendDist);

// Tauri's compile-time context requires frontendDist to exist even though this
// exact Rust test never loads frontend assets. Create only the empty directory
// and remove only that same empty directory afterwards.
if (createdFrontendDist) {
  mkdirSync(frontendDist);
}

let result;
try {
  for (const testName of [
    'commands::scan_scale_gate_tests::local_detail_queries_meet_100k_and_1m_budgets',
    'scanner::scanner_scale_gate_tests::provider_keyset_queries_stay_indexed_at_scale',
  ]) {
    result = spawnSync(
      'cargo',
      [
        'test',
        '--manifest-path',
        'src-tauri/Cargo.toml',
        testName,
        '--',
        '--ignored',
        '--exact',
        '--nocapture',
        '--test-threads=1',
      ],
      {
        cwd: projectRoot,
        env: process.env,
        stdio: 'inherit',
      },
    );
    if (result.error || result.status !== 0) {
      break;
    }
  }
} finally {
  if (createdFrontendDist) {
    try {
      rmdirSync(frontendDist);
    } catch (error) {
      console.warn(`Scale gate left non-empty temporary dist directory: ${error.message}`);
    }
  }
}

if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
