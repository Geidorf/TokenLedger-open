import assert from 'node:assert/strict';
import test from 'node:test';

import { validateUpgradeInspections } from './verify-android-upgrade-artifacts.mjs';

function inspection(overrides = {}) {
  return {
    applicationId: 'com.jeidorf.tokenledger.mobile',
    versionName: '1.2.65',
    versionCode: 10265,
    signerSha256: 'a'.repeat(64),
    sha256: 'b'.repeat(64),
    debuggable: false,
    ...overrides,
  };
}

test('accepts a non-debuggable same-certificate 1.2.65 to 1.2.66 upgrade', () => {
  assert.deepEqual(
    validateUpgradeInspections(
      inspection(),
      inspection({ versionName: '1.2.66', versionCode: 10266 }),
    ),
    {
      sameApplicationId: true,
      versionCodeIncreased: true,
      sameSigningCertificate: true,
      bothNonDebuggable: true,
    },
  );
});

test('rejects certificate, identity, debuggable and version regressions', () => {
  assert.throws(
    () =>
      validateUpgradeInspections(
        inspection(),
        inspection({
          versionName: '1.2.66',
          versionCode: 10266,
          signerSha256: 'c'.repeat(64),
        }),
      ),
    /different certificates/,
  );
  assert.throws(
    () =>
      validateUpgradeInspections(
        inspection(),
        inspection({
          applicationId: 'com.example.other',
          versionName: '1.2.66',
          versionCode: 10266,
        }),
      ),
    /RC applicationId/,
  );
  assert.throws(
    () =>
      validateUpgradeInspections(
        inspection(),
        inspection({ versionName: '1.2.66', versionCode: 10266, debuggable: true }),
      ),
    /must not be debuggable/,
  );
  assert.throws(
    () =>
      validateUpgradeInspections(
        inspection(),
        inspection({ versionName: '1.2.66', versionCode: 10265 }),
      ),
    /must be greater/,
  );
});

test('version transition comes from the release lineage instead of hard-coded numbers', () => {
  assert.deepEqual(
    validateUpgradeInspections(
      inspection({ versionName: '1.2.75', versionCode: 1002075 }),
      inspection({ versionName: '1.2.76', versionCode: 1002076 }),
      { previousVersion: '1.2.75', currentVersion: '1.2.76' },
    ).versionCodeIncreased,
    true,
  );
  assert.throws(
    () =>
      validateUpgradeInspections(
        inspection({ versionName: '1.2.75', versionCode: 1002075 }),
        inspection({ versionName: '1.2.76', versionCode: 1002076 }),
        { previousVersion: '1.2.74', currentVersion: '1.2.76' },
      ),
    /expected 1\.2\.74 -> 1\.2\.76/,
  );
  assert.throws(
    () =>
      validateUpgradeInspections(
        inspection({ versionName: '1.2.76', versionCode: 1002076 }),
        inspection({ versionName: '1.2.75', versionCode: 1002077 }),
      ),
    /newer versionName/,
  );
});
