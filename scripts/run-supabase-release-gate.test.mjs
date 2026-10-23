import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const gate = path.join(root, 'scripts/run-supabase-release-gate.mjs');
const project = 'tokenledger-t10308-sql-test';
const originalId = 'a'.repeat(64);
const recreatedId = 'b'.repeat(64);
const sqlNames = [
  'stats_v2_regression.sql', 'custom_date_range_regression.sql',
  'entity_machine_token_components_regression.sql', 'quota_snapshot_v2_regression.sql',
  'quota_snapshot_v3_regression.sql', 'quota_recovery_regression.sql',
  'quota_snapshot_capacity_regression.sql', 'quota_balance_reason_regression.sql',
  'gateway_aggregate_provenance_regression.sql', 'release_readiness_regression.sql',
];
const sql = new Map(sqlNames.map(name => [name, fs.readFileSync(path.join(root, 'supabase/tests', name), 'utf8')]));
const configText = `project_id = "${project}"
[api]
port = 65321
[db]
port = 65322
shadow_port = 65320
major_version = 17
[db.migrations]
enabled = true
schema_paths = []
[db.seed]
enabled = false
`;

function simulateGate({ failure = '', config = configText, alterFiles, env: overrides = {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenledger-supabase-gate-'));
  try {
    const workdir = path.join(directory, 'isolated');
    const supabase = path.join(workdir, 'supabase');
    fs.mkdirSync(supabase, { recursive: true });
    fs.cpSync(path.join(root, 'supabase/migrations'), path.join(supabase, 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(supabase, 'config.toml'), config);
    alterFiles?.(workdir);
    const traceFile = path.join(directory, 'trace.jsonl');
    const preload = path.join(directory, 'mock-commands.cjs');
    // Mock the entire child-process boundary; never invoke real Docker/CLI/database commands.
    fs.writeFileSync(preload, `
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const fail = process.env.GATE_TEST_FAILURE;
const project = ${JSON.stringify(project)};
const name = 'supabase_db_' + project;
let reset = false;
cp.spawnSync = (command, args, options = {}) => {
  fs.appendFileSync(process.env.GATE_TEST_TRACE, JSON.stringify({ command, args, input: options.input ?? null, timeout: options.timeout }) + '\\n');
  const cli = command === 'supabase' || command === 'npx' || command === 'npx.cmd';
  if (command === 'supabase' && args.length === 1 && ['offline', 'offline-missing'].includes(fail)) return { status: null, error: { message: 'ENOENT' } };
  if (command === 'npx' || command === 'npx.cmd') {
    if (JSON.stringify(args.slice(0, 3)) !== JSON.stringify(['--offline', '--no', 'supabase@2.109.1'])) throw Error('unsafe CLI download fallback');
    if (fail === 'offline-missing') return { status: 1, stdout: '' };
  }
  let stdout = '';
  let status = 0;
  if (cli && args.at(-1) === '--version') stdout = fail === 'version' ? '0.0.0' : '2.109.1';
  else if (cli && args.includes('--help')) {
    stdout = fail === 'lint-help' ? '--schema' : '--schema --fail-on';
    if (fail === 'config-drift') fs.appendFileSync(path.join(process.env.TOKENLEDGER_SUPABASE_GATE_WORKDIR, 'supabase/config.toml'), '\\n# changed');
    if (fail === 'migration-drift') {
      const dir = path.join(process.env.TOKENLEDGER_SUPABASE_GATE_WORKDIR, 'supabase/migrations');
      fs.appendFileSync(path.join(dir, fs.readdirSync(dir)[0]), '\\n-- changed');
    }
  }
  else if (cli && args.includes('reset')) {
    reset = true;
    if (fail === 'reset') status = 1;
    if (fail === 'reset-timeout') return { status: null, error: { message: 'ETIMEDOUT' } };
  }
  else if (cli && args.includes('lint')) { if (fail === 'lint') status = 1; }
  else if (command === 'docker' && args[0] === 'inspect') {
    if (fail === 'docker') return { status: 1, stdout: '' };
    const target = args[1];
    if ((!reset && target !== ${JSON.stringify(originalId)}) || (reset && target !== name)) throw Error('unsafe container selection ' + target);
    const item = {
      Id: reset ? ${JSON.stringify(recreatedId)} : ${JSON.stringify(originalId)}, Name: '/' + name,
      State: { Running: true },
      Config: { Image: 'public.ecr.aws/supabase/postgres:17.6.1.143', Labels: { 'com.supabase.cli.project': project, 'com.docker.compose.project': project } },
      HostConfig: { PortBindings: { '5432/tcp': [{ HostPort: '65322' }] } },
      NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '65322' }, { HostIp: '::', HostPort: '65322' }] } },
      Mounts: [{ Type: 'volume', Name: name, Source: '/var/lib/docker/volumes/' + name + '/_data', Destination: '/var/lib/postgresql/data', RW: true }],
    };
    if (fail === 'id') item.Id = ${JSON.stringify(recreatedId)};
    if (fail === 'name' || (reset && fail === 'post-name')) item.Name = '/supabase_db_tokenledger';
    if (fail === 'label' || (reset && fail === 'post-label')) item.Config.Labels['com.supabase.cli.project'] = 'tokenledger';
    if (fail === 'compose-label') item.Config.Labels['com.docker.compose.project'] = 'tokenledger';
    if (fail === 'image-major' || (reset && fail === 'post-image')) item.Config.Image = 'public.ecr.aws/supabase/postgres:16.6.1.143';
    if (fail === 'image-registry') item.Config.Image = 'untrusted.invalid/supabase/postgres:17.6.1.143';
    if (fail === 'image-ghcr') item.Config.Image = 'ghcr.io/supabase/postgres:17.6.1.143';
    if (fail === 'stopped') item.State.Running = false;
    if (fail === 'port') item.HostConfig.PortBindings['5432/tcp'][0].HostPort = '54322';
    if (fail === 'active-port' || (reset && fail === 'post-port')) item.NetworkSettings.Ports['5432/tcp'][0].HostPort = '54322';
    if (fail === 'missing-active-port') delete item.NetworkSettings.Ports['5432/tcp'];
    if (fail === 'mount') item.Mounts[0].Name = 'supabase_db_tokenledger';
    if (fail === 'bind') item.Mounts[0].Type = 'bind';
    if (fail === 'readonly' || (reset && fail === 'post-mount')) item.Mounts[0].RW = false;
    if (fail === 'volume-source' || (reset && fail === 'post-volume-source')) item.Mounts[0].Source = '/var/lib/docker/volumes/supabase_db_tokenledger/_data';
    if (fail === 'extra-mount') item.Mounts.push({ Type: 'volume', Name: 'supabase_db_tokenledger', Destination: '/extra', RW: true });
    if (fail === 'extra-bind') item.Mounts.push({ Type: 'bind', Source: '/user/data', Destination: '/extra', RW: true });
    if (fail === 'extra-own-volume') item.Mounts.push({ Type: 'volume', Name: 'extra_' + project, Destination: '/extra', RW: true });
    stdout = JSON.stringify([item]);
    if (fail === 'inspect-json') stdout = 'invalid';
    if (fail === 'inspect-multiple') stdout = JSON.stringify([item, item]);
  } else if (command === 'docker' && args[0] === 'volume') {
    const labels = { 'com.supabase.cli.project': project, 'com.docker.compose.project': project };
    if (fail === 'volume-label' || (reset && fail === 'post-volume-label')) labels['com.supabase.cli.project'] = 'tokenledger';
    if (fail === 'volume-compose-label') labels['com.docker.compose.project'] = 'tokenledger';
    const volume = { Name: name, Labels: labels, Driver: 'local', Scope: 'local', Options: null,
      Mountpoint: '/var/lib/docker/volumes/' + name + '/_data' };
    const backend = reset && fail.startsWith('post-') ? fail.slice(5) : fail;
    if (backend === 'volume-bind') volume.Options = { type: 'none', o: 'bind', device: '/var/lib/docker/volumes/supabase_db_tokenledger/_data' };
    if (backend === 'volume-nfs') volume.Options = { type: 'nfs', o: 'addr=server,rw', device: ':/user/postgres' };
    if (backend === 'volume-driver') volume.Driver = 'custom';
    if (backend === 'volume-scope') volume.Scope = 'global';
    if (backend === 'volume-path') volume.Mountpoint = '/var/lib/docker/volumes/supabase_db_tokenledger/_data';
    if (backend === 'volume-malformed-options') volume.Options = [];
    if (backend === 'volume-empty-options') volume.Options = {};
    stdout = JSON.stringify([volume]);
  } else if (command === 'docker' && args[0] === 'exec') {
    if (!reset || (args[2] !== ${JSON.stringify(recreatedId)} && args[1] !== ${JSON.stringify(recreatedId)})) throw Error('SQL without verified reset identity');
    if (args.includes('-c')) {
      stdout = fs.readdirSync(path.join(process.env.GATE_TEST_ROOT, 'supabase/migrations')).sort().map(file => file.replace(/\\.sql$/, '')).join('\\n');
      if (fail === 'history') stdout = 'unexpected';
    } else if (fail.endsWith('.sql') && options.input === fs.readFileSync(path.join(process.env.GATE_TEST_ROOT, 'supabase/tests', fail), 'utf8')) status = 1;
  } else throw Error('Unexpected command: ' + command + ' ' + args.join(' '));
  return { status, stdout };
};
require('node:module').syncBuiltinESMExports();
`);
    const result = spawnSync(process.execPath, ['--require', preload, gate], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, GATE_TEST_ROOT: root, GATE_TEST_TRACE: traceFile,
        GATE_TEST_FAILURE: failure, TOKENLEDGER_SUPABASE_GATE_WORKDIR: workdir,
        TOKENLEDGER_SUPABASE_GATE_PROJECT: project, TOKENLEDGER_SUPABASE_GATE_CONTAINER: originalId, ...overrides },
    });
    assert.equal(result.error, undefined);
    const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    return { result, trace, workdir: fs.realpathSync(workdir) };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function assertRejectedBeforeReset(options) {
  const { result, trace } = simulateGate(options);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(trace.some(({ args }) => args.includes('reset')), false);
  assert.equal(trace.some(({ args }) => args.includes('exec')), false);
  assert.doesNotMatch(result.stdout, /Supabase release gate passed/);
}

test('explicit verified isolation always resets, rebinds recreated ID, executes all SQL and strict lint', () => {
  const { result, trace, workdir } = simulateGate();
  assert.equal(result.status, 0, result.stderr);
  const resetIndex = trace.findIndex(({ args }) => args.includes('reset'));
  assert.ok(resetIndex > 0);
  assert.deepEqual(trace[resetIndex].args, ['--workdir', workdir, 'db', 'reset', '--local', '--no-seed']);
  const historyIndex = trace.findIndex(({ args }) => args.includes('-c'));
  assert.ok(historyIndex > resetIndex);
  const regressionCalls = trace.filter(({ input }) => input !== null);
  assert.equal(regressionCalls.length, sqlNames.length);
  assert.deepEqual(regressionCalls.map(({ input }) => [...sql].find(([, body]) => body === input)?.[0]), sqlNames);
  for (const call of regressionCalls) {
    assert.deepEqual(call.args.slice(0, 6), ['exec', '-i', recreatedId, 'psql', '-v', 'ON_ERROR_STOP=1']);
  }
  const fixture = regressionCalls.find(({ input }) => input === sql.get('quota_snapshot_capacity_regression.sql')).args.find(arg => arg.startsWith('capacity_fixture='));
  assert.deepEqual(JSON.parse(fixture.slice('capacity_fixture='.length)), JSON.parse(fs.readFileSync(path.join(root, 'fixtures/quota-provider-v1/transport-capacity-v1.json'), 'utf8')));
  const lint = trace.at(-1);
  assert.deepEqual(lint.args, ['--workdir', workdir, 'db', 'lint', '--local', '--schema', 'public,private', '--level', 'warning', '--fail-on', 'warning']);
  assert.ok(trace.every(({ timeout }) => timeout > 0 && timeout <= 120_000));
  assert.match(result.stdout, /Supabase release gate passed/);
  const emptyOptions = simulateGate({ failure: 'volume-empty-options' });
  assert.equal(emptyOptions.result.status, 0, emptyOptions.result.stderr);
  const ghcrMirror = simulateGate({ failure: 'image-ghcr' });
  assert.equal(ghcrMirror.result.status, 0, ghcrMirror.result.stderr);
});

test('missing explicit isolation and user repository/project/container targets fail before destructive commands', () => {
  for (const env of [
    { TOKENLEDGER_SUPABASE_GATE_WORKDIR: '' }, { TOKENLEDGER_SUPABASE_GATE_PROJECT: '' },
    { TOKENLEDGER_SUPABASE_GATE_CONTAINER: '' }, { TOKENLEDGER_SUPABASE_GATE_CONTAINER: 'abc123' },
    { TOKENLEDGER_SUPABASE_GATE_WORKDIR: root }, { TOKENLEDGER_SUPABASE_GATE_WORKDIR: 'relative' },
    { TOKENLEDGER_SUPABASE_GATE_PROJECT: 'tokenledger' },
  ]) assertRejectedBeforeReset({ env });
});

test('cached CLI fallback is offline and missing cache fails before reset', () => {
  const { result, trace } = simulateGate({ failure: 'offline' });
  assert.equal(result.status, 0, result.stderr);
  const commands = trace.filter(({ command }) => command === 'npx' || command === 'npx.cmd');
  assert.ok(commands.length > 0);
  assert.ok(commands.every(({ args }) => args.slice(0, 3).join(' ') === '--offline --no supabase@2.109.1'));
  assertRejectedBeforeReset({ failure: 'offline-missing' });
});

test('unsafe or ambiguous config fails before reset', () => {
  for (const config of [
    configText.replace(project, 'tokenledger-t10307-sql-old'),
    configText.replace('major_version = 17', 'major_version = 16'),
    configText.replace('enabled = false', 'enabled = true'),
    configText.replace('schema_paths = []', 'schema_paths = ["schema.sql"]'),
    configText.replace('enabled = true', 'enabled = false'),
    configText.replace('port = 65322', 'port = 54322'),
    configText.replace('shadow_port = 65320', 'shadow_port = 65322'),
    configText.replace('port = 65322', 'port = 65536'),
    configText.replace('project_id', '"project_id"'),
    configText.replace('project_id =', `project_id = "${project}"\nproject_id =`),
    configText + '\n[db.seed]\nenabled = false\n',
    configText.replace('[db.seed]', '["db".seed]'),
    configText + '\n[other]\nvalue = """\nproject_id="unsafe"\n"""\n',
  ]) assertRejectedBeforeReset({ config });
});

test('migration names and content must exactly match and paths cannot be symlinks', () => {
  const first = fs.readdirSync(path.join(root, 'supabase/migrations')).sort()[0];
  for (const alterFiles of [
    workdir => fs.appendFileSync(path.join(workdir, 'supabase/migrations', first), '\n-- drift'),
    workdir => fs.rmSync(path.join(workdir, 'supabase/migrations', first)),
    workdir => fs.writeFileSync(path.join(workdir, 'supabase/migrations/20260101000000_extra.sql'), '-- extra'),
    workdir => fs.writeFileSync(path.join(workdir, 'supabase/migrations/.hidden.sql'), '-- unexpected'),
    workdir => { const file = path.join(workdir, 'supabase/migrations', first); fs.rmSync(file); fs.symlinkSync(path.join(root, 'supabase/migrations', first), file); },
    workdir => { const file = path.join(workdir, 'supabase/config.toml'); fs.rmSync(file); fs.symlinkSync(path.join(root, 'supabase/config.toml'), file); },
    workdir => { const dir = path.join(workdir, 'supabase/migrations'); fs.rmSync(dir, { recursive: true }); fs.symlinkSync(path.join(root, 'supabase/migrations'), dir); },
    workdir => fs.writeFileSync(path.join(workdir, '.git'), 'gitdir: unsafe'),
    workdir => fs.writeFileSync(path.join(path.dirname(workdir), '.git'), 'gitdir: ancestor checkout'),
  ]) assertRejectedBeforeReset({ alterFiles });
});

test('Docker ID/name/labels/running/ports/data mount and volume ownership must all match', () => {
  for (const failure of ['docker', 'id', 'name', 'label', 'compose-label', 'image-major', 'image-registry', 'stopped', 'port', 'active-port', 'missing-active-port', 'mount', 'bind', 'readonly', 'extra-mount', 'extra-bind', 'extra-own-volume', 'volume-label', 'volume-compose-label', 'volume-bind', 'volume-nfs', 'volume-driver', 'volume-scope', 'volume-path', 'volume-source', 'volume-malformed-options', 'inspect-json', 'inspect-multiple', 'version', 'lint-help', 'config-drift', 'migration-drift']) {
    assertRejectedBeforeReset({ failure });
  }
});

test('reset failure, recreated identity mismatch or wrong history never executes regression SQL', () => {
  for (const failure of ['reset', 'reset-timeout', 'post-name', 'post-label', 'post-port', 'post-mount', 'post-volume-label', 'post-image', 'post-volume-bind', 'post-volume-nfs', 'post-volume-driver', 'post-volume-scope', 'post-volume-path', 'post-volume-source', 'post-volume-malformed-options', 'history']) {
    const { result, trace } = simulateGate({ failure });
    assert.equal(result.status, 1);
    assert.equal(trace.filter(({ args }) => args.includes('reset')).length, 1);
    assert.equal(trace.some(({ input }) => input !== null), false);
    if (failure !== 'history') assert.equal(trace.some(({ args }) => args.includes('exec')), false, failure);
    assert.doesNotMatch(result.stdout, /Supabase release gate passed/);
  }
});

test('every regression and final strict lint fail fast without publication', () => {
  for (const failure of [...sqlNames, 'lint']) {
    const { result, trace } = simulateGate({ failure });
    assert.equal(result.status, 1, failure);
    if (failure !== 'lint') assert.equal(trace.at(-1).input, sql.get(failure));
    assert.doesNotMatch(result.stdout, /Supabase release gate passed/);
  }
});
