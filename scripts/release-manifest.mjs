import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareReleaseVersions, parseReleaseVersion } from './release-lineage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHANNELS = new Set(['internal', 'private-signed', 'public-rc']);
const PLATFORMS = new Set(['macos', 'windows', 'android']);
const ARCHES = new Set(['arm64', 'x86_64', 'universal']);
const KINDS = new Set(['dmg', 'msi', 'apk', 'aab']);
const SIGNATURES = new Set(['verified', 'unverified', 'unsigned']);
const EVIDENCE_KINDS = new Set([
  'signature',
  'production-migration-history',
  'android-upgrade',
]);
const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'channel',
  'version',
  'previousRelease',
  'sourceSha',
  'builtAt',
  'supabaseMigrationHead',
  'artifacts',
  'evidence',
  'validationRefs',
]);
const ARTIFACT_KEYS = new Set([
  'platform',
  'arch',
  'kind',
  'file',
  'artifactVersion',
  'sizeBytes',
  'sha256',
  'signature',
  'signingIdentity',
  'signatureEvidenceRef',
  'buildEnvironment',
]);
const EVIDENCE_KEYS = new Set(['kind', 'file', 'sizeBytes', 'sha256']);
const PUBLIC_RC_ARTIFACTS = new Set([
  'macos:arm64:dmg',
  'windows:x86_64:msi',
  'android:universal:apk',
  'android:universal:aab',
]);

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function assertPlainObject(value, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    assert(allowed.has(key), `${label} has unsupported field "${key}"`);
  }
}

function assertString(value, label, { min = 1, max = 512, pattern } = {}) {
  assert(typeof value === 'string', `${label} must be a string`);
  assert(value.length >= min, `${label} must contain at least ${min} character(s)`);
  assert(value.length <= max, `${label} must contain no more than ${max} characters`);
  if (pattern) {
    assert(pattern.test(value), `${label} has an invalid format`);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`Unable to read JSON ${file}: ${error.message}`);
  }
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function packageVersion() {
  return readJson(path.join(root, 'package.json')).version;
}

function sourceSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
}

function migrationHead() {
  const migrationsDir = path.join(root, 'supabase', 'migrations');
  const migrations = fs
    .readdirSync(migrationsDir)
    .filter((file) => /^[0-9]{14}_[a-z0-9_]+\.sql$/.test(file))
    .sort();
  assert(migrations.length > 0, 'No Supabase migrations were found');
  return migrations.at(-1).replace(/\.sql$/, '');
}

function normalizeDate(value) {
  const date = value ? new Date(value) : new Date();
  assert(!Number.isNaN(date.getTime()), 'builtAt must be a valid date-time');
  return date.toISOString();
}

function validateArtifact(artifact, index) {
  const label = `artifacts[${index}]`;
  assertPlainObject(artifact, label);
  assertOnlyKeys(artifact, ARTIFACT_KEYS, label);
  assert(PLATFORMS.has(artifact.platform), `${label}.platform is unsupported`);
  assert(ARCHES.has(artifact.arch), `${label}.arch is unsupported`);
  assert(KINDS.has(artifact.kind), `${label}.kind is unsupported`);
  assertString(artifact.file, `${label}.file`, {
    max: 255,
    pattern: /^[^/\\]+$/,
  });
  assertString(artifact.artifactVersion, `${label}.artifactVersion`, {
    pattern: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
  });
  assert(Number.isSafeInteger(artifact.sizeBytes) && artifact.sizeBytes > 0, `${label}.sizeBytes must be positive`);
  assertString(artifact.sha256, `${label}.sha256`, {
    min: 64,
    max: 64,
    pattern: /^[0-9a-f]{64}$/,
  });
  assert(SIGNATURES.has(artifact.signature), `${label}.signature is unsupported`);
  assertString(artifact.buildEnvironment, `${label}.buildEnvironment`);

  if (artifact.signature === 'verified') {
    assertString(artifact.signingIdentity, `${label}.signingIdentity`);
    assertString(artifact.signatureEvidenceRef, `${label}.signatureEvidenceRef`, {
      max: 255,
      pattern: /^[^/\\]+$/,
    });
  } else {
    assert(
      artifact.signingIdentity === null,
      `${label}.signingIdentity must be null unless the signature was verified`,
    );
    assert(
      artifact.signatureEvidenceRef === undefined,
      `${label}.signatureEvidenceRef is only allowed for verified signatures`,
    );
  }

  const expected = {
    macos: { arch: 'arm64', kinds: new Set(['dmg']) },
    windows: { arch: 'x86_64', kinds: new Set(['msi']) },
    android: { arch: 'universal', kinds: new Set(['apk', 'aab']) },
  }[artifact.platform];
  assert(artifact.arch === expected.arch, `${label} has an invalid platform/architecture pairing`);
  assert(expected.kinds.has(artifact.kind), `${label} has an invalid platform/artifact pairing`);
}

function validateEvidence(item, index) {
  const label = `evidence[${index}]`;
  assertPlainObject(item, label);
  assertOnlyKeys(item, EVIDENCE_KEYS, label);
  assert(EVIDENCE_KINDS.has(item.kind), `${label}.kind is unsupported`);
  assertString(item.file, `${label}.file`, {
    max: 255,
    pattern: /^[^/\\]+$/,
  });
  assert(Number.isSafeInteger(item.sizeBytes) && item.sizeBytes > 0, `${label}.sizeBytes must be positive`);
  assertString(item.sha256, `${label}.sha256`, {
    min: 64,
    max: 64,
    pattern: /^[0-9a-f]{64}$/,
  });
}

export function validateManifest(manifest, { artifactsDir } = {}) {
  assertPlainObject(manifest, 'manifest');
  assertOnlyKeys(manifest, TOP_LEVEL_KEYS, 'manifest');
  assert(manifest.schemaVersion === 1, 'schemaVersion must be 1');
  assert(CHANNELS.has(manifest.channel), 'channel is unsupported');
  assertString(manifest.version, 'version', {
    pattern: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
  });
  if (Object.hasOwn(manifest, 'previousRelease')) {
    assert(
      manifest.previousRelease === null || typeof manifest.previousRelease === 'string',
      'previousRelease must be an older MAJOR.MINOR.PATCH version or null',
    );
    if (typeof manifest.previousRelease === 'string') {
      assertString(manifest.previousRelease, 'previousRelease', { pattern: /^\d+\.\d+\.\d+$/ });
      const current = parseReleaseVersion(manifest.version.split('-')[0]);
      assert(
        compareReleaseVersions(parseReleaseVersion(manifest.previousRelease), current) < 0,
        `previousRelease ${manifest.previousRelease} must be older than version ${manifest.version}`,
      );
    }
  }
  assertString(manifest.sourceSha, 'sourceSha', {
    min: 40,
    max: 40,
    pattern: /^[0-9a-f]{40}$/,
  });
  assertString(manifest.builtAt, 'builtAt');
  assert(
    new Date(manifest.builtAt).toISOString() === manifest.builtAt,
    'builtAt must be an ISO-8601 UTC date-time',
  );
  assertString(manifest.supabaseMigrationHead, 'supabaseMigrationHead', {
    pattern: /^[0-9]{14}_[a-z0-9_]+$/,
  });
  assert(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0, 'artifacts must not be empty');
  manifest.artifacts.forEach(validateArtifact);
  assert(
    manifest.artifacts.every(({ artifactVersion }) => artifactVersion === manifest.version),
    'every artifactVersion must match manifest.version',
  );
  assert(Array.isArray(manifest.evidence), 'evidence must be an array');
  manifest.evidence.forEach(validateEvidence);
  assert(
    Array.isArray(manifest.validationRefs) && manifest.validationRefs.length > 0,
    'validationRefs must not be empty',
  );
  manifest.validationRefs.forEach((ref, index) => assertString(ref, `validationRefs[${index}]`));
  assert(
    new Set(manifest.validationRefs).size === manifest.validationRefs.length,
    'validationRefs must be unique',
  );

  const files = manifest.artifacts.map((artifact) => artifact.file);
  assert(new Set(files).size === files.length, 'artifact file names must be unique');
  const evidenceFiles = manifest.evidence.map((item) => item.file);
  assert(new Set(evidenceFiles).size === evidenceFiles.length, 'evidence file names must be unique');
  assert(
    files.every((file) => !evidenceFiles.includes(file)),
    'artifact and evidence file names must be disjoint',
  );

  const verifiedArtifacts = manifest.artifacts.filter(
    ({ signature }) => signature === 'verified',
  );
  const signatureRefs = verifiedArtifacts.map(({ signatureEvidenceRef }) => signatureEvidenceRef);
  assert(
    new Set(signatureRefs).size === signatureRefs.length,
    'verified artifacts must use distinct signature evidence files',
  );
  const signatureEvidence = manifest.evidence.filter(({ kind }) => kind === 'signature');
  assert(
    signatureEvidence.length === signatureRefs.length,
    'signature evidence count must equal the verified artifact count',
  );
  for (const artifact of verifiedArtifacts) {
    const matchingEvidence = manifest.evidence.filter(
      (item) => item.kind === 'signature' && item.file === artifact.signatureEvidenceRef,
    );
    assert(
      matchingEvidence.length === 1,
      `${artifact.signatureEvidenceRef} must identify one content-addressed signature evidence file`,
    );
  }

  if (manifest.channel !== 'internal') {
    assert(
      manifest.artifacts.every((artifact) => artifact.signature === 'verified'),
      `${manifest.channel} manifests may contain only verified signed artifacts`,
    );
    const productionEvidence = manifest.evidence.filter(
      ({ kind }) => kind === 'production-migration-history',
    );
    assert(
      productionEvidence.length === 1,
      `${manifest.channel} manifests require exactly one production migration evidence file`,
    );
  }

  if (manifest.channel === 'public-rc') {
    const actual = new Set(
      manifest.artifacts.map((artifact) => `${artifact.platform}:${artifact.arch}:${artifact.kind}`),
    );
    assert(actual.size === PUBLIC_RC_ARTIFACTS.size, 'public-rc must contain exactly four platform artifacts');
    for (const required of PUBLIC_RC_ARTIFACTS) {
      assert(actual.has(required), `public-rc is missing ${required}`);
    }
    // 升级证据的"上一版"来自发布血统（release-lineage.mjs），不再写死版本号。
    // 首个公开发布没有上一版可升级，必须显式写 previousRelease: null 而不是省略，
    // 这样"忘了带升级证据"和"确实没有上一版"在 manifest 里可区分。
    assert(
      Object.hasOwn(manifest, 'previousRelease'),
      'public-rc manifests must declare previousRelease (older version string, or null for the first public release)',
    );
    const upgradeEvidence = manifest.evidence.filter(({ kind }) => kind === 'android-upgrade');
    if (manifest.previousRelease === null) {
      assert(
        upgradeEvidence.length === 0,
        'public-rc manifests without a previous release must not carry Android upgrade evidence',
      );
    } else {
      assert(
        upgradeEvidence.length === 1,
        `public-rc manifests require exactly one Android ${manifest.previousRelease} to ${manifest.version} upgrade evidence file`,
      );
    }
  }

  if (artifactsDir) {
    for (const artifact of manifest.artifacts) {
      const absolutePath = path.resolve(artifactsDir, artifact.file);
      const relative = path.relative(path.resolve(artifactsDir), absolutePath);
      assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `Unsafe artifact path ${artifact.file}`);
      const stat = fs.lstatSync(absolutePath);
      assert(stat.isFile() && !stat.isSymbolicLink(), `${artifact.file} must be a regular file`);
      assert(stat.size === artifact.sizeBytes, `${artifact.file} size does not match manifest`);
      assert(sha256(absolutePath) === artifact.sha256, `${artifact.file} SHA-256 does not match manifest`);
    }
    for (const item of manifest.evidence) {
      const absolutePath = path.resolve(artifactsDir, item.file);
      const relative = path.relative(path.resolve(artifactsDir), absolutePath);
      assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `Unsafe evidence path ${item.file}`);
      const stat = fs.lstatSync(absolutePath);
      assert(stat.isFile() && !stat.isSymbolicLink(), `${item.file} must be a regular file`);
      assert(stat.size === item.sizeBytes, `${item.file} size does not match manifest`);
      assert(sha256(absolutePath) === item.sha256, `${item.file} SHA-256 does not match manifest`);
    }
  }

  return manifest;
}

function evidenceFromFile(file, kind) {
  const stat = fs.lstatSync(file);
  assert(
    stat.isFile() && !stat.isSymbolicLink() && stat.size > 0,
    `${file} must be a non-empty regular evidence file`,
  );
  const result = {
    kind,
    file: path.basename(file),
    sizeBytes: stat.size,
    sha256: sha256(file),
  };
  validateEvidence(result, 0);
  return result;
}

function bundleFromDescriptor(descriptorFile) {
  const descriptor = readJson(descriptorFile);
  assertPlainObject(descriptor, `descriptor ${descriptorFile}`);
  assertOnlyKeys(descriptor, new Set(['schemaVersion', 'artifact']), `descriptor ${descriptorFile}`);
  assert(descriptor.schemaVersion === 1, `${descriptorFile} schemaVersion must be 1`);
  assertPlainObject(descriptor.artifact, `${descriptorFile}.artifact`);
  const { artifact } = descriptor;
  const descriptorKeys = new Set([
    'path',
    'platform',
    'arch',
    'kind',
    'artifactVersion',
    'signature',
    'signingIdentity',
    'signatureEvidenceRef',
    'buildEnvironment',
  ]);
  assertOnlyKeys(artifact, descriptorKeys, `${descriptorFile}.artifact`);

  const absolutePath = path.resolve(path.dirname(descriptorFile), artifact.path);
  const relative = path.relative(path.dirname(descriptorFile), absolutePath);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${descriptorFile} has an unsafe path`);
  const stat = fs.lstatSync(absolutePath);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${artifact.path} must be a regular file`);

  const artifactResult = {
    platform: artifact.platform,
    arch: artifact.arch,
    kind: artifact.kind,
    artifactVersion: artifact.artifactVersion,
    file: path.basename(absolutePath),
    sizeBytes: stat.size,
    sha256: sha256(absolutePath),
    signature: artifact.signature,
    signingIdentity: artifact.signingIdentity ?? null,
    buildEnvironment: artifact.buildEnvironment,
  };
  const evidence = [];
  if (artifact.signatureEvidenceRef !== undefined) {
    const evidencePath = path.resolve(path.dirname(descriptorFile), artifact.signatureEvidenceRef);
    const evidenceRelative = path.relative(path.dirname(descriptorFile), evidencePath);
    assert(
      evidenceRelative
        && !evidenceRelative.startsWith('..')
        && !path.isAbsolute(evidenceRelative),
      `${descriptorFile} has an unsafe signature evidence path`,
    );
    const signatureEvidence = evidenceFromFile(evidencePath, 'signature');
    artifactResult.signatureEvidenceRef = signatureEvidence.file;
    evidence.push(signatureEvidence);
  }
  return { artifact: artifactResult, evidence };
}

function buildManifest({
  channel,
  artifacts,
  evidence = [],
  validationRefs,
  builtAt,
  version,
  previousRelease,
  commit,
  migration,
}) {
  const manifest = {
    schemaVersion: 1,
    channel,
    version: version ?? packageVersion(),
    ...(previousRelease === undefined ? {} : { previousRelease }),
    sourceSha: commit ?? sourceSha(),
    builtAt: normalizeDate(builtAt),
    supabaseMigrationHead: migration ?? migrationHead(),
    artifacts,
    evidence,
    validationRefs,
  };
  return validateManifest(manifest);
}

function parseOptions(args) {
  const values = new Map();
  const repeatable = new Set(['descriptor', 'validation-ref']);
  for (let index = 0; index < args.length; index += 2) {
    const token = args[index];
    assert(token?.startsWith('--'), `Unexpected argument ${token ?? '<missing>'}`);
    const name = token.slice(2);
    const value = args[index + 1];
    assert(value !== undefined, `${token} requires a value`);
    if (repeatable.has(name)) {
      values.set(name, [...(values.get(name) ?? []), value]);
    } else {
      assert(!values.has(name), `${token} may be provided only once`);
      values.set(name, value);
    }
  }
  return values;
}

function requireOption(options, name) {
  const value = options.get(name);
  assert(value !== undefined, `--${name} is required`);
  return value;
}

function writeJson(file, value) {
  const absolutePath = path.resolve(file);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`);
  return absolutePath;
}

function collectDescriptorFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectDescriptorFiles(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith('.artifact.json')) {
      result.push(absolutePath);
    }
  }
  return result.sort();
}

function collectNamedEvidenceFiles(directory) {
  const known = new Map([
    ['production-migration-evidence.json', 'production-migration-history'],
    ['android-upgrade-evidence.json', 'android-upgrade'],
  ]);
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectNamedEvidenceFiles(absolutePath));
    } else if (entry.isFile() && known.has(entry.name)) {
      result.push({ file: absolutePath, kind: known.get(entry.name) });
    }
  }
  return result.sort((left, right) => left.file.localeCompare(right.file));
}

function migrationFromProductionEvidence(file, expectedSourceSha, expectedVersion) {
  const value = readJson(file);
  assertPlainObject(value, 'production migration evidence');
  assert(value.schemaVersion === 1, 'production migration evidence schemaVersion must be 1');
  assert(
    value.evidenceType === 'production-supabase-migration-history',
    'production migration evidence has the wrong type',
  );
  assert(value.exactHistoryMatch === true, 'production migration history was not an exact match');
  assert(value.sourceSha === expectedSourceSha, 'production migration evidence source SHA differs');
  assert(
    value.supabaseCliVersion === '2.109.1',
    'production migration evidence was not created by the pinned Supabase CLI',
  );
  assert(
    typeof value.generatedAt === 'string'
      && new Date(value.generatedAt).toISOString() === value.generatedAt,
    'production migration evidence has an invalid generatedAt',
  );
  assert(
    typeof value.projectRef === 'string' && /^[a-z0-9]{20}$/.test(value.projectRef),
    'production migration evidence has an invalid project ref',
  );
  assert(
    ['database-hostname', 'pooler-role-suffix'].includes(value.databaseProjectBinding),
    'production migration evidence does not bind its database identity to the project ref',
  );
  assert(
    value.clientProjectBinding === 'standard-project-hostname',
    'production migration evidence does not bind its client URL to the project ref',
  );
  assert(
    JSON.stringify(value.command)
      === JSON.stringify([
        'supabase',
        'migration',
        'list',
        '--db-url',
        '<protected-read-only-db-url>',
      ]),
    'production migration evidence was not produced by the read-only command',
  );
  assertString(value.verifiedMigrationHead, 'production evidence verifiedMigrationHead', {
    pattern: /^[0-9]{14}_[a-z0-9_]+$/,
  });
  assert(
    value.remoteHeadVersion === value.verifiedMigrationHead.slice(0, 14),
    'production migration evidence remote head differs from its verified migration',
  );
  assert(
    Array.isArray(value.localVersions)
      && Array.isArray(value.remoteVersions)
      && value.localVersions.length > 0
      && JSON.stringify(value.localVersions) === JSON.stringify(value.remoteVersions)
      && value.remoteVersions.every((version) => /^[0-9]{14}$/.test(version))
      && value.remoteVersions.at(-1) === value.remoteHeadVersion,
    'production migration evidence has an invalid remote history',
  );
  assert(
    Array.isArray(value.repositoryMigrations)
      && value.repositoryMigrations.length === value.remoteVersions.length
      && value.repositoryMigrations.every(
        (migration, index) =>
          /^[0-9]{14}_[a-z0-9_]+$/.test(migration)
          && migration.slice(0, 14) === value.remoteVersions[index],
    ),
    'production migration evidence does not bind repository migration names to remote versions',
  );
  assertPlainObject(value.workflowRun, 'production migration evidence workflowRun');
  assertString(value.workflowRun.repository, 'production evidence workflow repository', {
    pattern: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  });
  assertString(value.workflowRun.workflow, 'production evidence workflow name');
  assertString(value.workflowRun.runId, 'production evidence workflow runId', {
    pattern: /^[1-9][0-9]*$/,
  });
  assertString(value.workflowRun.runAttempt, 'production evidence workflow runAttempt', {
    pattern: /^[1-9][0-9]*$/,
  });
  assertString(value.workflowRun.refName, 'production evidence workflow refName', {
    pattern: /^v\d+\.\d+\.\d+$/,
  });
  assert(
    value.workflowRun.refName === `v${expectedVersion}`,
    'production migration evidence workflow refName differs from the candidate release tag',
  );
  assert(
    value.historySha256
      === createHash('sha256')
        .update(JSON.stringify(value.remoteVersions))
        .digest('hex'),
    'production migration evidence history digest differs',
  );
  return value.verifiedMigrationHead;
}

function validateAndroidUpgradeEvidence(file, expectedSourceSha, transition) {
  assertPlainObject(transition, 'Android upgrade transition');
  assertString(transition.previousVersion, 'transition.previousVersion', { pattern: /^\d+\.\d+\.\d+$/ });
  assertString(transition.currentVersion, 'transition.currentVersion', { pattern: /^\d+\.\d+\.\d+$/ });
  const value = readJson(file);
  assertPlainObject(value, 'Android upgrade evidence');
  assert(value.schemaVersion === 1, 'Android upgrade evidence schemaVersion must be 1');
  assert(value.evidenceType === 'android-signed-upgrade', 'Android upgrade evidence has the wrong type');
  assert(value.sourceSha === expectedSourceSha, 'Android upgrade evidence source SHA differs');
  assert(
    typeof value.generatedAt === 'string'
      && new Date(value.generatedAt).toISOString() === value.generatedAt,
    'Android upgrade evidence has an invalid generatedAt',
  );
  assert(
    value.applicationId === 'com.jeidorf.tokenledger.mobile',
    'Android upgrade evidence has an invalid applicationId',
  );
  assert(
    value.privateRelease?.versionName === transition.previousVersion
      && value.publicRc?.versionName === transition.currentVersion
      && Number.isSafeInteger(value.privateRelease?.versionCode)
      && Number.isSafeInteger(value.publicRc?.versionCode)
      && value.publicRc.versionCode > value.privateRelease.versionCode,
    'Android upgrade evidence has an invalid version transition',
  );
  assert(
    /^[0-9a-f]{64}$/.test(value.privateRelease?.signerSha256)
      && value.privateRelease.signerSha256 === value.publicRc?.signerSha256,
    'Android upgrade evidence does not prove one signing certificate',
  );
  for (const [label, release] of [
    ['private', value.privateRelease],
    ['public RC', value.publicRc],
  ]) {
    assert(
      /^[0-9a-f]{64}$/.test(release?.apkSha256),
      `Android ${label} upgrade evidence has an invalid APK digest`,
    );
    assertPlainObject(release?.workflowRun, `Android ${label} workflowRun`);
    assertString(release.workflowRun.id, `Android ${label} workflow run id`, {
      pattern: /^[1-9][0-9]*$/,
    });
    assertString(release.workflowRun.url, `Android ${label} workflow run URL`, {
      pattern: /^https:\/\/github[.]com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*$/,
    });
  }
  assertString(value.privateRelease.workflowRun.headSha, 'Android private workflow head SHA', {
    min: 40,
    max: 40,
    pattern: /^[0-9a-f]{40}$/,
  });
  assert(
    value.assertions?.sameApplicationId === true
      && value.assertions?.versionCodeIncreased === true
      && value.assertions?.sameSigningCertificate === true
      && value.assertions?.bothNonDebuggable === true,
    'Android upgrade evidence assertions are incomplete',
  );
}

function describe(options) {
  const artifactPath = path.resolve(requireOption(options, 'file'));
  const stat = fs.lstatSync(artifactPath);
  assert(stat.isFile() && !stat.isSymbolicLink(), '--file must point to a regular artifact');
  const signature = requireOption(options, 'signature');
  const signingIdentity = options.get('signing-identity') ?? null;
  const descriptor = {
    schemaVersion: 1,
    artifact: {
      path: path.basename(artifactPath),
      platform: requireOption(options, 'platform'),
      arch: requireOption(options, 'arch'),
      kind: requireOption(options, 'kind'),
      artifactVersion: requireOption(options, 'artifact-version'),
      signature,
      signingIdentity,
      buildEnvironment: requireOption(options, 'build-environment'),
    },
  };
  if (options.has('signature-evidence-ref')) {
    descriptor.artifact.signatureEvidenceRef = options.get('signature-evidence-ref');
  }

  const preview = {
    ...descriptor.artifact,
    file: path.basename(artifactPath),
    sizeBytes: stat.size,
    sha256: sha256(artifactPath),
  };
  delete preview.path;
  validateArtifact(preview, 0);

  const output = writeJson(requireOption(options, 'output'), descriptor);
  console.log(`Artifact descriptor written: ${output}`);
}

function generate(options) {
  const specFile = path.resolve(requireOption(options, 'spec'));
  const spec = readJson(specFile);
  assertPlainObject(spec, 'spec');
  assertOnlyKeys(
    spec,
    new Set([
      'channel',
      'builtAt',
      'version',
      'previousRelease',
      'sourceSha',
      'supabaseMigrationHead',
      'validationRefs',
      'artifacts',
    ]),
    'spec',
  );
  assert(Array.isArray(spec.artifacts), 'spec.artifacts must be an array');
  const descriptorFiles = spec.artifacts.map((item, index) => {
    assertString(item, `spec.artifacts[${index}]`);
    return path.resolve(path.dirname(specFile), item);
  });
  const bundles = descriptorFiles.map(bundleFromDescriptor);
  const manifest = buildManifest({
    channel: spec.channel,
    artifacts: bundles.map(({ artifact }) => artifact),
    evidence: bundles.flatMap(({ evidence }) => evidence),
    validationRefs: spec.validationRefs,
    builtAt: spec.builtAt,
    version: spec.version,
    previousRelease: spec.previousRelease,
    commit: spec.sourceSha,
    migration: spec.supabaseMigrationHead,
  });
  const output = writeJson(requireOption(options, 'output'), manifest);
  console.log(`Release manifest written: ${output}`);
}

function parsePreviousReleaseOption(options) {
  if (!options.has('previous-release')) return undefined;
  const raw = options.get('previous-release').trim();
  if (raw === 'none' || raw === 'null' || raw === '') return null;
  assert(/^\d+\.\d+\.\d+$/.test(raw), '--previous-release must be MAJOR.MINOR.PATCH or none');
  return raw;
}

function assemble(options) {
  const descriptorRoot = path.resolve(requireOption(options, 'descriptor-root'));
  const descriptorFiles = [
    ...(options.get('descriptor') ?? []).map((file) => path.resolve(file)),
    ...collectDescriptorFiles(descriptorRoot),
  ];
  assert(descriptorFiles.length > 0, 'No *.artifact.json descriptors were found');
  const bundles = descriptorFiles.map(bundleFromDescriptor);
  const namedEvidenceFiles = collectNamedEvidenceFiles(descriptorRoot);
  const evidence = [
    ...bundles.flatMap((bundle) => bundle.evidence),
    ...namedEvidenceFiles.map(({ file, kind }) => evidenceFromFile(file, kind)),
  ];
  const channel = requireOption(options, 'channel');
  const commit = options.get('source-sha') ?? sourceSha();
  const version = options.get('version') ?? packageVersion();
  const productionEvidence = namedEvidenceFiles.filter(
    ({ kind }) => kind === 'production-migration-history',
  );
  let migration = options.get('supabase-migration-head');
  if (channel !== 'internal') {
    assert(
      productionEvidence.length === 1,
      'signed manifests require exactly one production migration evidence file',
    );
    const measuredMigration = migrationFromProductionEvidence(
      productionEvidence[0].file,
      commit,
      version,
    );
    assert(
      migration === undefined || migration === measuredMigration,
      'workflow migration head differs from the content-addressed production evidence',
    );
    migration = measuredMigration;
  }
  const androidUpgradeEvidence = namedEvidenceFiles.filter(
    ({ kind }) => kind === 'android-upgrade',
  );
  const previousRelease = parsePreviousReleaseOption(options);
  if (channel === 'public-rc') {
    assert(
      previousRelease !== undefined,
      'public RC manifests require --previous-release <older version|none> from the release lineage',
    );
    if (previousRelease === null) {
      assert(
        androidUpgradeEvidence.length === 0,
        'first public release: Android upgrade evidence must be absent',
      );
    } else {
      assert(
        androidUpgradeEvidence.length === 1,
        'public RC manifests require exactly one Android upgrade evidence file',
      );
      validateAndroidUpgradeEvidence(androidUpgradeEvidence[0].file, commit, {
        previousVersion: previousRelease,
        currentVersion: version.split('-')[0],
      });
    }
  } else {
    assert(
      androidUpgradeEvidence.length === 0,
      'Android upgrade evidence is only valid for the public RC channel',
    );
  }
  const manifest = buildManifest({
    channel,
    artifacts: bundles.map(({ artifact }) => artifact),
    evidence,
    validationRefs: options.get('validation-ref') ?? [],
    builtAt: options.get('built-at'),
    version,
    previousRelease,
    commit,
    migration,
  });
  const output = writeJson(requireOption(options, 'output'), manifest);
  console.log(`Release manifest written: ${output}`);
}

function validate(options) {
  const manifestFile = path.resolve(requireOption(options, 'manifest'));
  const manifest = readJson(manifestFile);
  validateManifest(manifest, {
    artifactsDir: options.has('artifacts-dir') ? path.resolve(options.get('artifacts-dir')) : undefined,
  });
  console.log(`Release manifest is valid: ${manifestFile}`);
}

function usage() {
  return [
    'Usage:',
    '  node scripts/release-manifest.mjs describe --file <artifact> --platform <...> --arch <...>',
    '    --kind <...> --artifact-version <...> --signature <...> --build-environment <...> --output <descriptor>',
    '    [--signing-identity <identity> --signature-evidence-ref <ref>]',
    '  node scripts/release-manifest.mjs generate --spec <spec.json> --output <manifest.json>',
    '  node scripts/release-manifest.mjs assemble --descriptor-root <dir> --channel <channel>',
    '    --validation-ref <ref> --output <manifest.json>',
    '  node scripts/release-manifest.mjs validate --manifest <manifest.json> [--artifacts-dir <dir>]',
  ].join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (!command || command === '--help') {
      console.log(usage());
      process.exit(command ? 0 : 2);
    }
    const options = parseOptions(args);
    if (command === 'describe') {
      describe(options);
    } else if (command === 'generate') {
      generate(options);
    } else if (command === 'assemble') {
      assemble(options);
    } else if (command === 'validate') {
      validate(options);
    } else {
      fail(`Unknown command ${command}`);
    }
  } catch (error) {
    console.error(`Release manifest error: ${error.message}`);
    process.exit(1);
  }
}
