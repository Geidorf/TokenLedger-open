import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseMigrationList,
  validateProductionClientUrl,
  validateProductionDatabaseUrl,
  verifyExactMigrationHistory,
} from './production-migration-evidence.mjs';

const migrations = [
  { version: '20260715010101', migration: '20260715010101_first' },
  { version: '20260716020202', migration: '20260716020202_second' },
];

test('parses pinned CLI unicode migration table and verifies exact history', () => {
  const output = `
Connecting to remote database...
   LOCAL          │ REMOTE         │ TIME (UTC)
  ─────────────────┼────────────────┼──────────────────────
   20260715010101 │ 20260715010101 │ 2026-07-15 01:01:01
   20260716020202 │ 20260716020202 │ 2026-07-16 02:02:02
`;
  const rows = parseMigrationList(output);
  assert.deepEqual(verifyExactMigrationHistory(rows, migrations), {
    local: ['20260715010101', '20260716020202'],
    remote: ['20260715010101', '20260716020202'],
  });
});

test('parses ASCII table emitted by non-unicode terminals', () => {
  const output = `
 LOCAL           | REMOTE          | TIME (UTC)
 20260715010101  | 20260715010101  | 2026-07-15 01:01:01
 20260716020202  | 20260716020202  | 2026-07-16 02:02:02
`;
  assert.equal(parseMigrationList(output).length, 2);
});

test('rejects a local-only or remote-only migration row', () => {
  const localOnly = parseMigrationList(`
 LOCAL | REMOTE | TIME
 20260715010101 | 20260715010101 | t
 20260716020202 |                | t
`);
  assert.throws(
    () => verifyExactMigrationHistory(localOnly, migrations),
    /remote=<missing>/,
  );
  const remoteOnly = parseMigrationList(`
 LOCAL | REMOTE | TIME
 20260715010101 | 20260715010101 | t
                | 20260716020202 | t
`);
  assert.throws(
    () => verifyExactMigrationHistory(remoteOnly, migrations),
    /local=<missing>/,
  );
});

test('rejects missing, reordered and duplicate history', () => {
  assert.throws(
    () =>
      verifyExactMigrationHistory(
        [{ local: '20260715010101', remote: '20260715010101' }],
        migrations,
      ),
    /does not exactly match/,
  );
  assert.throws(
    () =>
      verifyExactMigrationHistory(
        [
          { local: '20260716020202', remote: '20260716020202' },
          { local: '20260715010101', remote: '20260715010101' },
        ],
        migrations,
      ),
    /does not exactly match/,
  );
  assert.throws(
    () =>
      verifyExactMigrationHistory(
        [
          { local: '20260715010101', remote: '20260715010101' },
          { local: '20260715010101', remote: '20260715010101' },
        ],
        migrations,
      ),
    /duplicate/,
  );
});

test('rejects output when not every migration version is in a parsed table row', () => {
  assert.throws(
    () => parseMigrationList('unexpected 20260715010101 output without a table'),
    /unsupported or incomplete/,
  );
});

test('binds the protected project ref through a direct host or pooler role suffix', () => {
  const ref = 'abcdefghijklmnopqrst';
  assert.deepEqual(
    validateProductionDatabaseUrl(
      `postgresql://release_reader:secret@db.${ref}.supabase.co:5432/postgres`,
      ref,
    ),
    { projectBinding: 'database-hostname' },
  );
  assert.deepEqual(
    validateProductionDatabaseUrl(
      `postgresql://release_reader.${ref}:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
      ref,
    ),
    { projectBinding: 'pooler-role-suffix' },
  );
});

test('rejects project-ref mismatches and privileged pooler identities', () => {
  const ref = 'abcdefghijklmnopqrst';
  assert.throws(
    () =>
      validateProductionDatabaseUrl(
        'postgresql://release_reader:secret@db.zyxwvutsrqponmlkjihg.supabase.co/postgres',
        ref,
      ),
    /not bound/,
  );
  assert.throws(
    () =>
      validateProductionDatabaseUrl(
        `postgresql://postgres.${ref}:secret@aws-0-us-east-1.pooler.supabase.com/postgres`,
        ref,
      ),
    /privileged/,
  );
});

test('binds the embedded client URL to the same protected project ref', () => {
  const ref = 'abcdefghijklmnopqrst';
  assert.deepEqual(
    validateProductionClientUrl(`https://${ref}.supabase.co`, ref),
    { projectBinding: 'standard-project-hostname' },
  );
  assert.throws(
    () =>
      validateProductionClientUrl(
        'https://zyxwvutsrqponmlkjihg.supabase.co',
        ref,
      ),
    /not bound/,
  );
  assert.throws(
    () => validateProductionClientUrl(`http://${ref}.supabase.co`, ref),
    /not bound/,
  );
});
