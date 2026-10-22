import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  assertAllowedSupabaseClientKey,
  classifySupabaseClientKey,
  isAllowedSupabaseClientKey,
} from './supabase-client-key.mjs';

const fixture = fs
  .readFileSync(new URL('./fixtures/supabase-client-key-cases.txt', import.meta.url), 'utf8')
  .split(/\r?\n/)
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => {
    const [label, accepted, key] = line.split('|');
    return { label, accepted: accepted === 'true', key };
  });

test('shared Supabase client-key fixture is fail-closed', () => {
  assert(fixture.some(({ accepted }) => accepted));
  assert(fixture.some(({ accepted }) => !accepted));
  for (const { label, accepted, key } of fixture) {
    assert.equal(isAllowedSupabaseClientKey(key), accepted, label);
  }
});

test('accepted keys are classified without exposing their value', () => {
  assert.equal(classifySupabaseClientKey('sb_publishable_ci_fixture'), 'publishable');
  assert.equal(
    classifySupabaseClientKey(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
        + '.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIn0.c2lnbmF0dXJl',
    ),
    'legacy-anon',
  );
  assert.throws(
    () => assertAllowedSupabaseClientKey('sb_secret_fixture', 'release key'),
    /sb_publishable_\*/,
  );
});
