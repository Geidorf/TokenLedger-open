import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectAndroidArtifact,
  selectPrivateReleaseRun,
} from './find-private-android-release-run.mjs';

const sha = 'a'.repeat(40);

test('selects the newest successful run for the immutable private tag SHA', () => {
  const selected = selectPrivateReleaseRun(
    [
      {
        id: 10,
        status: 'completed',
        conclusion: 'success',
        event: 'push',
        head_sha: sha,
        path: '.github/workflows/release-rc.yml@refs/tags/v1.2.65',
        run_attempt: 1,
      },
      {
        id: 11,
        status: 'completed',
        conclusion: 'failure',
        event: 'push',
        head_sha: sha,
        path: '.github/workflows/release-rc.yml@refs/tags/v1.2.65',
        run_attempt: 2,
      },
      {
        id: 12,
        status: 'completed',
        conclusion: 'success',
        event: 'push',
        head_sha: sha,
        path: '.github/workflows/release-rc.yml@refs/tags/v1.2.65',
        run_attempt: 2,
      },
    ],
    sha,
    '99',
    'v1.2.65',
  );
  assert.equal(selected.id, 12);
});

test('rejects successful runs from another source SHA', () => {
  assert.throws(
    () =>
      selectPrivateReleaseRun(
        [{
          id: 10,
          status: 'completed',
          conclusion: 'success',
          event: 'push',
          head_sha: 'b'.repeat(40),
          path: '.github/workflows/release-rc.yml@refs/tags/v1.2.65',
        }],
        sha,
        '99',
        'v1.2.65',
      ),
    /no successful/,
  );
});

test('rejects a branch run at the same SHA because it is not the private tag ref', () => {
  assert.throws(
    () =>
      selectPrivateReleaseRun(
        [{
          id: 10,
          status: 'completed',
          conclusion: 'success',
          event: 'push',
          head_sha: sha,
          path: '.github/workflows/release-rc.yml@main',
        }],
        sha,
        '99',
        'v1.2.65',
      ),
    /no successful/,
  );
});

test('requires a formal previous release tag instead of a hard-coded version', () => {
  assert.throws(
    () => selectPrivateReleaseRun([], sha, '99', undefined),
    /TOKENLEDGER_PREVIOUS_RELEASE_TAG must be a formal/,
  );
  assert.throws(
    () => selectPrivateReleaseRun([], sha, '99', 'v1.2.76-rc.1'),
    /TOKENLEDGER_PREVIOUS_RELEASE_TAG must be a formal/,
  );
});

test('requires exactly one unexpired release-android artifact', () => {
  assert.equal(
    selectAndroidArtifact([{ id: 7, name: 'release-android', expired: false }]).id,
    7,
  );
  assert.throws(
    () => selectAndroidArtifact([{ id: 7, name: 'release-android', expired: true }]),
    /found 0/,
  );
  assert.throws(
    () =>
      selectAndroidArtifact([
        { id: 7, name: 'release-android', expired: false },
        { id: 8, name: 'release-android', expired: false },
      ]),
    /found 2/,
  );
});
