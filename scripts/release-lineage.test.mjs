import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareReleaseVersions,
  parseReleaseVersion,
  resolvePreviousRelease,
} from './release-lineage.mjs';

test('parses release versions with or without the v prefix and rejects prereleases', () => {
  assert.deepEqual(parseReleaseVersion('v1.2.75'), [1, 2, 75]);
  assert.deepEqual(parseReleaseVersion('1.2.100'), [1, 2, 100]);
  assert.equal(parseReleaseVersion('v1.2.76-rc.1'), null);
  assert.equal(parseReleaseVersion(''), null);
  assert.equal(compareReleaseVersions([1, 2, 100], [1, 3, 0]), -1);
  assert.equal(compareReleaseVersions([1, 3, 0], [1, 2, 101]), 1);
});

test('picks the newest formal tag strictly older than the current version', () => {
  const previous = resolvePreviousRelease({
    currentVersion: '1.2.76',
    tags: ['v1.2.65', 'v1.2.66', 'v1.2.75', 'v1.2.76', 'v1.3.0', 'v1.2.76-rc.1', 'nightly'],
  });
  assert.deepEqual(previous, { tag: 'v1.2.75', version: '1.2.75' });
});

test('returns null for the first formal release', () => {
  assert.equal(resolvePreviousRelease({ currentVersion: '1.2.76', tags: [] }), null);
  assert.equal(resolvePreviousRelease({ currentVersion: '1.2.76', tags: ['v1.3.0', 'v2.0.0'] }), null);
});

test('honours an explicit override and refuses a non-older one', () => {
  assert.deepEqual(
    resolvePreviousRelease({ currentVersion: '1.2.76', tags: ['v1.2.75'], override: 'v1.2.66' }),
    { tag: 'v1.2.66', version: '1.2.66' },
  );
  assert.equal(
    resolvePreviousRelease({ currentVersion: '1.2.76', tags: ['v1.2.75'], override: 'none' }),
    null,
  );
  assert.throws(
    () => resolvePreviousRelease({ currentVersion: '1.2.76', tags: [], override: 'v1.2.76' }),
    /not older/,
  );
  assert.throws(
    () => resolvePreviousRelease({ currentVersion: '1.2.76', tags: [], override: '1.2.66' }),
    /vMAJOR\.MINOR\.PATCH/,
  );
  assert.throws(() => resolvePreviousRelease({ currentVersion: 'latest' }), /MAJOR\.MINOR\.PATCH/);
});
