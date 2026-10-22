import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PINNED_CLI_VERSION = '2.109.1';

function fail(message) {
  throw new Error(message);
}

function requireValue(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`required protected variable ${name} is missing`);
  }
  return value;
}

function parseArgs(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined || options.has(flag.slice(2))) {
      fail(`invalid argument ${flag ?? '<missing>'}`);
    }
    options.set(flag.slice(2), value);
  }
  return options;
}

export function repositoryMigrations(directory = path.join(root, 'supabase', 'migrations')) {
  const migrations = fs
    .readdirSync(directory)
    .filter((file) => /^[0-9]{14}_[a-z0-9_]+\.sql$/.test(file))
    .sort()
    .map((file) => ({
      version: file.slice(0, 14),
      migration: file.replace(/\.sql$/, ''),
    }));
  if (migrations.length === 0) {
    fail('repository contains no Supabase migrations');
  }
  if (new Set(migrations.map(({ version }) => version)).size !== migrations.length) {
    fail('repository contains duplicate Supabase migration versions');
  }
  return migrations;
}

export function parseMigrationList(output) {
  if (typeof output !== 'string' || output.trim() === '') {
    fail('Supabase migration list output is empty');
  }
  const rows = [];
  let capturedVersions = 0;
  for (const line of output.replaceAll('\r', '').split('\n')) {
    const match = line.match(/^\s*(\d{14})?\s*[|│]\s*(\d{14})?\s*[|│]/);
    if (!match || (!match[1] && !match[2])) {
      continue;
    }
    rows.push({ local: match[1] ?? null, remote: match[2] ?? null });
    capturedVersions += Number(Boolean(match[1])) + Number(Boolean(match[2]));
  }
  const allVersions = output.match(/\b\d{14}\b/g) ?? [];
  if (rows.length === 0 || capturedVersions !== allVersions.length) {
    fail('Supabase migration list output has an unsupported or incomplete table format');
  }
  return rows;
}

export function verifyExactMigrationHistory(rows, migrations) {
  const expected = migrations.map(({ version }) => version);
  const local = [];
  const remote = [];
  for (const [index, row] of rows.entries()) {
    if (!row.local || !row.remote) {
      fail(
        `migration history diverges at row ${index + 1}: `
          + `local=${row.local ?? '<missing>'}, remote=${row.remote ?? '<missing>'}`,
      );
    }
    if (row.local !== row.remote) {
      fail(`migration history differs at row ${index + 1}: ${row.local} != ${row.remote}`);
    }
    local.push(row.local);
    remote.push(row.remote);
  }
  if (new Set(local).size !== local.length || new Set(remote).size !== remote.length) {
    fail('migration history contains duplicate versions');
  }
  if (JSON.stringify(local) !== JSON.stringify(expected)) {
    fail(
      `local migration history does not exactly match the repository: `
        + `expected ${expected.join(', ')}, got ${local.join(', ')}`,
    );
  }
  if (JSON.stringify(remote) !== JSON.stringify(expected)) {
    fail(
      `production migration history does not exactly match the repository: `
        + `expected ${expected.join(', ')}, got ${remote.join(', ')}`,
    );
  }
  return { local, remote };
}

function run(command, args, { redactArgs = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error) {
    fail(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const commandLabel = redactArgs ? command : `${command} ${args.join(' ')}`;
    fail(`${commandLabel} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

export function validateProductionDatabaseUrl(value, projectRef) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('TOKENLEDGER_PRODUCTION_SUPABASE_READONLY_DB_URL is not a valid URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !parsed.hostname
    || !parsed.username
    || !parsed.password
  ) {
    fail(
      'TOKENLEDGER_PRODUCTION_SUPABASE_READONLY_DB_URL must be a credentialed PostgreSQL URL',
    );
  }
  let databaseRole;
  try {
    databaseRole = decodeURIComponent(parsed.username);
  } catch {
    fail('production read-only database URL has an invalid encoded role');
  }
  if (/^(?:postgres|supabase_admin)(?:[.]|$)/.test(databaseRole.toLowerCase())) {
    fail('production migration evidence must not use a known privileged PostgreSQL role');
  }
  const boundByHostname = parsed.hostname === `db.${projectRef}.supabase.co`;
  const boundByPoolerRole = databaseRole.endsWith(`.${projectRef}`);
  if (!boundByHostname && !boundByPoolerRole) {
    fail('production read-only database URL is not bound to the protected project ref');
  }
  return {
    projectBinding: boundByHostname ? 'database-hostname' : 'pooler-role-suffix',
  };
}

export function validateProductionClientUrl(value, projectRef) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('TOKENLEDGER_SUPABASE_URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== `${projectRef}.supabase.co`) {
    fail('production client URL is not bound to the protected Supabase project ref');
  }
  return { projectBinding: 'standard-project-hostname' };
}

function writeEvidence(file, value) {
  const absolutePath = path.resolve(file);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return absolutePath;
}

function appendGithubOutput(values) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    return;
  }
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n');
  fs.appendFileSync(outputFile, `${lines}\n`);
}

function workflowRun() {
  return {
    repository: requireValue('GITHUB_REPOSITORY'),
    workflow: requireValue('GITHUB_WORKFLOW'),
    runId: requireValue('GITHUB_RUN_ID'),
    runAttempt: requireValue('GITHUB_RUN_ATTEMPT'),
    refName: requireValue('GITHUB_REF_NAME'),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = options.get('output');
  if (!output) {
    fail('--output is required');
  }
  const databaseUrl = requireValue('TOKENLEDGER_PRODUCTION_SUPABASE_READONLY_DB_URL');
  const projectRef = requireValue('TOKENLEDGER_PRODUCTION_SUPABASE_PROJECT_REF');
  if (!/^[a-z0-9]{20}$/.test(projectRef)) {
    fail('TOKENLEDGER_PRODUCTION_SUPABASE_PROJECT_REF must be a 20-character project ref');
  }
  const databaseIdentity = validateProductionDatabaseUrl(databaseUrl, projectRef);
  const clientIdentity = validateProductionClientUrl(
    requireValue('TOKENLEDGER_SUPABASE_URL'),
    projectRef,
  );

  const versionOutput = run('supabase', ['--version']).stdout.trim();
  if (versionOutput !== PINNED_CLI_VERSION) {
    fail(`Supabase CLI must be ${PINNED_CLI_VERSION}; got ${versionOutput || '<empty>'}`);
  }
  const migrations = repositoryMigrations();
  const listed = run(
    'supabase',
    ['migration', 'list', '--db-url', databaseUrl],
    { redactArgs: true },
  );
  const rows = parseMigrationList(`${listed.stdout}\n${listed.stderr}`);
  const histories = verifyExactMigrationHistory(rows, migrations);
  const sourceSha = requireValue('GITHUB_SHA');
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    fail('GITHUB_SHA must be an immutable 40-character source SHA');
  }
  const generatedAt = new Date().toISOString();
  const verifiedMigrationHead = migrations.at(-1).migration;
  const evidence = {
    schemaVersion: 1,
    evidenceType: 'production-supabase-migration-history',
    generatedAt,
    sourceSha,
    projectRef,
    databaseProjectBinding: databaseIdentity.projectBinding,
    clientProjectBinding: clientIdentity.projectBinding,
    workflowRun: workflowRun(),
    supabaseCliVersion: PINNED_CLI_VERSION,
    command: ['supabase', 'migration', 'list', '--db-url', '<protected-read-only-db-url>'],
    repositoryMigrations: migrations.map(({ migration }) => migration),
    localVersions: histories.local,
    remoteVersions: histories.remote,
    remoteHeadVersion: histories.remote.at(-1),
    verifiedMigrationHead,
    exactHistoryMatch: true,
    historySha256: createHash('sha256')
      .update(JSON.stringify(histories.remote))
      .digest('hex'),
  };
  const evidenceFile = writeEvidence(output, evidence);
  appendGithubOutput({
    migration_head: verifiedMigrationHead,
    remote_head_version: evidence.remoteHeadVersion,
    evidence_file: path.basename(evidenceFile),
  });
  console.log(
    `Production Supabase migration history verified read-only at ${verifiedMigrationHead}; `
      + `evidence ${evidenceFile}.`,
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`Production migration evidence failed: ${error.message}`);
    process.exit(1);
  }
}
