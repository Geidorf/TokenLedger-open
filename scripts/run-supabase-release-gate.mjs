import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const fixturePath = path.join(root, 'fixtures', 'quota-provider-v1', 'transport-v2.json');
const expectedCliVersion = '2.109.1';
let supabaseInvocation;
let isolation;

function compactFixture(name) {
  const file = path.join(root, 'fixtures', 'quota-provider-v1', name);
  return JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function fail(message) {
  console.error(`Supabase release gate failed: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`\n==> ${options.label ?? `${command} ${args.join(' ')}`}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: options.capture ? 'utf8' : undefined,
    input: options.input,
    stdio: options.capture ? ['pipe', 'pipe', 'inherit'] : options.input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
    timeout: options.timeout ?? 120_000,
  });
  if (result.error) {
    fail(`${options.label ?? command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${options.label ?? command} exited with ${result.status}`);
  }
  return result.stdout?.trim();
}

function expectedMigrations() {
  return fs
    .readdirSync(migrationsDir)
    .filter((file) => /^[0-9]{14}_[a-z0-9_]+\.sql$/.test(file))
    .sort()
    .map((file) => file.replace(/\.sql$/, ''));
}

function regularPath(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`unsafe ${directory ? 'directory' : 'file'}: ${file}`);
  }
}

function isInsideCheckout(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    try {
      fs.lstatSync(path.join(current, '.git'));
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (path.dirname(current) === current) return false;
  }
}

function migrationFingerprint(directory) {
  regularPath(directory, true);
  return fs.readdirSync(directory).sort().map(file => {
    if (!/^[0-9]{14}_[a-z0-9_]+\.sql$/.test(file)) throw new Error(`unexpected migration entry: ${file}`);
    const absolute = path.join(directory, file);
    regularPath(absolute);
    return [file, createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')];
  });
}

function readSafetyConfig(file) {
  regularPath(file);
  const values = new Map();
  const tables = new Set();
  let section = '';
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (raw.includes('"""') || raw.includes("'''")) throw new Error('multiline config strings are unsupported');
    // Only unambiguous plain TOML keys/tables are accepted for destructive targeting.
    const line = raw.replace(/"(?:[^"\\]|\\.)*"|'[^']*'|#.*/g, token => token.startsWith('#') ? '' : token).trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      const table = /^\[([a-z_][a-z0-9_.]*)\]$/.exec(line);
      if (!table || tables.has(table[1])) throw new Error('ambiguous or duplicate config table');
      section = table[1];
      tables.add(section);
      continue;
    }
    const entry = /^([a-z_][a-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!entry) throw new Error('ambiguous safety config key');
    const key = `${section}.${entry[1]}`;
    if (values.has(key)) throw new Error(`duplicate config key: ${key}`);
    values.set(key, entry[2]);
  }
  const project = /^"([a-z0-9-]+)"$/.exec(values.get('.project_id') ?? '')?.[1];
  if (!project || values.get('db.major_version') !== '17'
      || values.get('db.migrations.enabled') !== 'true'
      || !/^\[\s*\]$/.test(values.get('db.migrations.schema_paths') ?? '')
      || values.get('db.seed.enabled') !== 'false') {
    throw new Error('config must bind a project, PG17, enabled migrations, empty schema_paths and disabled seed');
  }
  const ports = [...values].filter(([key]) => /\.(port|shadow_port)$/.test(key));
  const seenPorts = new Set();
  for (const [key, raw] of ports) {
    const port = Number(raw);
    if (!/^[0-9]+$/.test(raw) || port < 1 || port > 65535
        || (port >= 54320 && port <= 54329) || seenPorts.has(port)) {
      throw new Error(`unsafe or duplicate dedicated port: ${key}`);
    }
    seenPorts.add(port);
  }
  if (!values.has('db.port') || !values.has('db.shadow_port')) throw new Error('database and shadow ports are required');
  return { project, port: Number(values.get('db.port')), bytes: fs.readFileSync(file) };
}

function verifyFiles() {
  const config = readSafetyConfig(isolation.config);
  if (config.project !== isolation.project || config.port !== isolation.port
      || !config.bytes.equals(isolation.configBytes)) throw new Error('isolated configuration changed or mismatched');
  const expected = migrationFingerprint(migrationsDir);
  const actual = migrationFingerprint(isolation.migrations);
  if (!expected.length || JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error('isolated migration names/content differ from the current repository');
  }
}

function readIsolation() {
  const workdir = process.env.TOKENLEDGER_SUPABASE_GATE_WORKDIR;
  const project = process.env.TOKENLEDGER_SUPABASE_GATE_PROJECT;
  const container = process.env.TOKENLEDGER_SUPABASE_GATE_CONTAINER;
  if (!workdir || !path.isAbsolute(workdir) || !project || !/^[a-f0-9]{64}$/.test(container ?? '')) {
    throw new Error('explicit absolute WORKDIR, dedicated PROJECT and full 64-hex CONTAINER are required');
  }
  if (project.length > 64 || !/^tokenledger-t[0-9]+[a-z0-9-]*-sql-[a-z0-9-]+$/.test(project)) {
    throw new Error('project must be a dedicated tokenledger task SQL project, never the user project');
  }
  const canonical = fs.realpathSync(workdir);
  const canonicalRoot = fs.realpathSync(root);
  const relative = path.relative(canonicalRoot, canonical);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      || isInsideCheckout(canonical)) throw new Error('workdir must be outside repository checkouts');
  regularPath(canonical, true);
  const supabase = path.join(canonical, 'supabase');
  regularPath(supabase, true);
  const configFile = path.join(supabase, 'config.toml');
  const config = readSafetyConfig(configFile);
  if (config.project !== project) throw new Error('project does not match the dedicated config');
  return { workdir: canonical, project, expectedId: container, port: config.port,
    config: configFile, configBytes: config.bytes, migrations: path.join(supabase, 'migrations') };
}

function inspectJson(kind, target) {
  const args = kind === 'container' ? ['inspect', target] : ['volume', 'inspect', target];
  const text = run('docker', args, { capture: true, label: `Verify dedicated ${kind} ${target}`, timeout: 20_000 });
  const objects = JSON.parse(text);
  if (!Array.isArray(objects) || objects.length !== 1) throw new Error(`ambiguous ${kind} identity`);
  return objects[0];
}

function verifyContainer(target, expectedId) {
  const info = inspectJson('container', target);
  const name = `supabase_db_${isolation.project}`;
  const labels = info.Config?.Labels;
  if (!/^[a-f0-9]{64}$/.test(info.Id ?? '') || (expectedId && info.Id !== expectedId)
      || info.Name !== `/${name}` || info.State?.Running !== true
      // ghcr.io/supabase is the CLI's own fallback mirror when ECR rate-limits anonymous pulls.
      || !/^(?:public\.ecr\.aws\/|ghcr\.io\/|docker\.io\/)?supabase\/postgres:17\.[0-9]+(?:\.[0-9]+)*$/.test(info.Config?.Image ?? '')
      || labels?.['com.supabase.cli.project'] !== isolation.project
      || labels?.['com.docker.compose.project'] !== isolation.project) throw new Error('dedicated container identity/labels/state mismatch');
  for (const bindings of [info.HostConfig?.PortBindings?.['5432/tcp'], info.NetworkSettings?.Ports?.['5432/tcp']]) {
    if (!Array.isArray(bindings) || !bindings.length || bindings.some(binding => binding.HostPort !== String(isolation.port))) {
      throw new Error('dedicated database configured/active port does not match the config');
    }
  }
  const data = info.Mounts;
  if (!Array.isArray(data) || data.length !== 1 || data[0].Destination !== '/var/lib/postgresql/data'
      || data[0].Type !== 'volume' || data[0].Name !== name || data[0].RW !== true) {
    throw new Error('dedicated database must use only its own project data volume');
  }
  const volume = inspectJson('volume', name);
  const standardMountpoint = `/var/lib/docker/volumes/${name}/_data`;
  const plainOptions = volume.Options === null || (typeof volume.Options === 'object'
    && !Array.isArray(volume.Options) && volume.Options !== null && Object.keys(volume.Options).length === 0);
  if (volume.Name !== name || volume.Labels?.['com.supabase.cli.project'] !== isolation.project
      || volume.Labels?.['com.docker.compose.project'] !== isolation.project) throw new Error('data volume ownership mismatch');
  // A correctly named volume can still alias user data through bind/NFS driver options.
  if (volume.Driver !== 'local' || volume.Scope !== 'local' || !plainOptions
      || volume.Mountpoint !== standardMountpoint || data[0].Source !== standardMountpoint) {
    throw new Error('data volume must use the standard isolated local backend without driver options');
  }
  return info.Id;
}

function psql(container, { file, args = [], label }) {
  const sql = fs.readFileSync(path.join(root, file), 'utf8');
  run(
    'docker',
    ['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', ...args],
    { input: sql, label },
  );
}

function resolveSupabaseInvocation() {
  const direct = spawnSync('supabase', ['--version'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (!direct.error && direct.status === 0) {
    return { command: 'supabase', prefix: [] };
  }
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return { command: npx, prefix: ['--offline', '--no', `supabase@${expectedCliVersion}`] };
}

function runSupabase(args, options = {}) {
  return run(
    supabaseInvocation.command,
    [...supabaseInvocation.prefix, '--workdir', isolation.workdir, ...args],
    options,
  );
}

try {
  isolation = readIsolation();
  verifyFiles();
  verifyContainer(isolation.expectedId, isolation.expectedId);
} catch (error) {
  fail(`unsafe isolation: ${error.message}`);
}

supabaseInvocation = resolveSupabaseInvocation();
const actualCliVersion = runSupabase(['--version'], {
  capture: true,
  label: `Verify pinned Supabase CLI ${expectedCliVersion}`,
});
if (actualCliVersion !== expectedCliVersion) {
  fail(`expected Supabase CLI ${expectedCliVersion}, got ${actualCliVersion || '<empty>'}`);
}

const lintHelp = runSupabase(['db', 'lint', '--help'], {
  capture: true,
  label: 'Verify pinned CLI lint flags',
});
if (!lintHelp.includes('--schema') || !lintHelp.includes('--fail-on')) {
  fail('pinned Supabase CLI does not expose the required db lint flags');
}

try {
  verifyFiles();
  verifyContainer(isolation.expectedId, isolation.expectedId);
} catch (error) {
  fail(`unsafe isolation before reset: ${error.message}`);
}
runSupabase(['db', 'reset', '--local', '--no-seed'], {
  label: 'Fresh database replay from supabase/migrations',
});

let container;
try {
  verifyFiles();
  // Reset may recreate the container. Resolve only the exact owned name, never another database.
  container = verifyContainer(`supabase_db_${isolation.project}`);
} catch (error) {
  fail(`unsafe isolation after reset: ${error.message}`);
}
console.log(`Using local database container: ${container}`);

const migrations = expectedMigrations();
const applied = run(
  'docker',
  [
    'exec',
    container,
    'psql',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-c',
    "select version || '_' || name from supabase_migrations.schema_migrations order by version",
  ],
  { capture: true, label: 'Verify exact local migration history' },
)
  .split('\n')
  .filter(Boolean);

if (JSON.stringify(applied) !== JSON.stringify(migrations)) {
  fail(
    `migration history differs from the repository\nExpected: ${migrations.join(', ')}\nApplied: ${applied.join(', ')}`,
  );
}

psql(container, {
  file: 'supabase/tests/stats_v2_regression.sql',
  label: 'Stats v1/v2, RLS, contract and EXPLAIN regression',
});
psql(container, {
  file: 'supabase/tests/custom_date_range_regression.sql',
  label: 'Custom range boundaries, DST, year-crossing and dailyCosts regression',
});
psql(container, {
  file: 'supabase/tests/entity_machine_token_components_regression.sql',
  label: 'Entity and machine token components, unknown versus zero regression',
});
psql(container, {
  file: 'supabase/tests/quota_snapshot_v2_regression.sql',
  args: ['-v', `transport_v2_fixture=${JSON.stringify(JSON.parse(fs.readFileSync(fixturePath, 'utf8')))}`],
  label: 'Quota v1/v2 compatibility and RLS regression',
});
psql(container, {
  file: 'supabase/tests/quota_snapshot_v3_regression.sql',
  args: [
    '-v', `transport_v3_fixture=${compactFixture('transport-v3.json')}`,
    '-v', `currency_fixture=${compactFixture('currency-v1.json')}`,
  ],
  label: 'Quota transport v3 currency gating, v2 projection and RLS regression',
});
psql(container, {
  file: 'supabase/tests/quota_recovery_regression.sql',
  args: ['-v', `capacity_fixture=${compactFixture('transport-capacity-v1.json')}`],
  label: 'Quota observation truth, owner-bound clear metadata and recovery regression',
});
psql(container, {
  file: 'supabase/tests/quota_snapshot_capacity_regression.sql',
  args: ['-v', `capacity_fixture=${compactFixture('transport-capacity-v1.json')}`],
  label: 'Quota active capacity, tombstone revival and atomic rollback regression',
});
psql(container, {
  file: 'supabase/tests/quota_balance_reason_regression.sql',
  args: ['-v', `balance_fixture=${compactFixture('balance-v1.json')}`],
  label: 'Quota balance reason codes, v2 projection and RLS regression',
});
psql(container, {
  file: 'supabase/tests/gateway_aggregate_provenance_regression.sql',
  label: 'Gateway-merged aggregate provenance, RLS and delete refresh regression',
});
psql(container, {
  file: 'supabase/tests/routing_snapshot_regression.sql',
  label: 'Live routing snapshot relay, validation, capacity and RLS regression',
});
psql(container, {
  file: 'supabase/tests/cloud_heatmap_metrics_activity_rhythm_regression.sql',
  label: 'Cloud heatmap record counts/costs and activity rhythm RPC, filters and grants regression',
});
psql(container, {
  file: 'supabase/tests/usage_dimensions_cloud_regression.sql',
  label: 'Cloud usage dimensions (sessions, providers, context) sync, retention, reads and RLS regression',
});
psql(container, {
  file: 'supabase/tests/release_readiness_regression.sql',
  label: 'Release security, signature compatibility and EXPLAIN regression',
});

runSupabase(
  ['db', 'lint', '--local', '--schema', 'public,private', '--level', 'warning', '--fail-on', 'warning'],
  { label: 'Supabase schema lint (warnings fail)' },
);

console.log(`\nSupabase release gate passed at ${migrations.at(-1)}.`);
