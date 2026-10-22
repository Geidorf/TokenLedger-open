#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

const executable = process.argv[2];
if (!executable || !isAbsolute(executable)) {
  throw new Error('usage: node scripts/codex-config-rpc-smoke.mjs /absolute/path/to/codex');
}

const root = mkdtempSync(join(tmpdir(), 'tokenledger-codex-rpc-smoke-'));
const home = join(root, 'home');
const codexHome = join(root, 'codex');
const sqliteHome = join(root, 'state');
mkdirSync(home);
mkdirSync(codexHome);
mkdirSync(sqliteHome);
writeFileSync(join(codexHome, 'config.toml'), `model_provider = "before"
[model_providers.before]
name = "Before"
base_url = "https://before.invalid/v1"
env_key = "TOKENLEDGER_DUMMY_BEFORE_KEY"
wire_api = "responses"
[model_providers.after]
name = "After"
base_url = "https://after.invalid/v1"
env_key = "TOKENLEDGER_DUMMY_AFTER_KEY"
wire_api = "responses"
`);

const childEnv = {
  HOME: home,
  CODEX_HOME: codexHome,
  CODEX_SQLITE_HOME: sqliteHome,
  PATH: `${dirname(executable)}:/usr/bin:/bin`,
  LANG: 'C.UTF-8',
};
const version = spawnSync(executable, ['--version'], {
  env: childEnv,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
  timeout: 5_000,
});
if (version.status !== 0 || !version.stdout.trim()) throw new Error('codex --version failed');

const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
  env: childEnv,
  stdio: ['pipe', 'pipe', 'ignore'],
});
const pending = new Map();
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  const callback = pending.get(message.id);
  if (callback) {
    pending.delete(message.id);
    callback(message);
  }
});
let nextId = 0;
function request(method, params) {
  const id = ++nextId;
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout:${method}`));
    }, 8_000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      if (message.error) reject(message.error);
      else resolve(message.result);
    });
  });
}

try {
  const initialized = await request('initialize', {
    clientInfo: {
      name: 'tokenledger_fixture_smoke',
      title: 'TokenLedger Fixture Smoke',
      version: '1.2.77',
    },
    capabilities: {},
  });
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  const before = await request('config/read', { includeLayers: true, cwd: null });
  const requirements = await request('configRequirements/read', null);
  const userLayer = before.layers.find((layer) => layer.name.type === 'user' && !layer.name.profile);
  const version1 = userLayer.version;
  const applied = await request('config/batchWrite', {
    edits: [
      { keyPath: 'model_provider', value: 'after', mergeStrategy: 'replace' },
      { keyPath: 'model', value: 'gpt-fixture', mergeStrategy: 'replace' },
    ],
    filePath: null,
    expectedVersion: version1,
    reloadUserConfig: false,
  });
  const after = await request('config/read', { includeLayers: true, cwd: null });
  let staleCode = null;
  try {
    await request('config/batchWrite', {
      edits: [{ keyPath: 'model_provider', value: 'before', mergeStrategy: 'replace' }],
      filePath: null,
      expectedVersion: version1,
      reloadUserConfig: false,
    });
  } catch (error) {
    staleCode = error?.data?.config_write_error_code ?? 'unknown';
  }
  const restored = await request('config/batchWrite', {
    edits: [
      { keyPath: 'model_provider', value: 'before', mergeStrategy: 'replace' },
      { keyPath: 'model', value: null, mergeStrategy: 'replace' },
    ],
    filePath: null,
    expectedVersion: applied.version,
    reloadUserConfig: false,
  });
  const final = await request('config/read', { includeLayers: true, cwd: null });
  const finalUserLayer = final.layers.find((layer) => layer.name.type === 'user' && !layer.name.profile);
  const summary = {
    codexVersion: version.stdout.trim(),
    codexHomeMatches: initialized.codexHome === codexHome,
    requirementsTopLevelKeys: Object.keys(requirements).sort(),
    applyStatus: applied.status,
    applyPathMatches: applied.filePath === join(codexHome, 'config.toml'),
    appliedProvider: after.config.model_provider,
    appliedModel: after.config.model,
    staleCode,
    restoreStatus: restored.status,
    restoredProvider: final.config.model_provider,
    restoredUserModelMissing: !Object.hasOwn(finalUserLayer.config, 'model'),
  };
  const expected = summary.codexHomeMatches
    && summary.requirementsTopLevelKeys.length === 1
    && summary.requirementsTopLevelKeys[0] === 'requirements'
    && summary.applyStatus === 'ok'
    && summary.applyPathMatches
    && summary.appliedProvider === 'after'
    && summary.appliedModel === 'gpt-fixture'
    && summary.staleCode === 'configVersionConflict'
    && summary.restoreStatus === 'ok'
    && summary.restoredProvider === 'before'
    && summary.restoredUserModelMissing;
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!expected) process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill();
  rmSync(root, { recursive: true, force: true });
}
