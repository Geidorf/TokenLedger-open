import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateManifest } from './release-manifest.mjs';

const schema = JSON.parse(
  fs.readFileSync(new URL('../release-manifest.schema.json', import.meta.url), 'utf8'),
);
const manifestCli = fileURLToPath(new URL('./release-manifest.mjs', import.meta.url));
// 生成器把 manifest.version 绑定到 package.json；夹具里的制品版本必须跟着
// 根版本走，否则每次显式升版都会让这条测试（以及 CI frontend-check）变红。
const packageVersion = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

function artifact(overrides = {}) {
  const content = Buffer.from('tokenledger-release-fixture');
  return {
    platform: 'android',
    arch: 'universal',
    kind: 'apk',
    file: 'TokenLedger.apk',
    artifactVersion: '1.2.64',
    sizeBytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    signature: 'unsigned',
    signingIdentity: null,
    buildEnvironment: 'test fixture',
    ...overrides,
  };
}

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    channel: 'internal',
    version: '1.2.64',
    sourceSha: '1'.repeat(40),
    builtAt: '2026-07-28T02:30:00.000Z',
    supabaseMigrationHead: '20260728021444_m10_release_security_hardening',
    artifacts: [artifact()],
    evidence: [],
    validationRefs: ['docs/task-logs/T10.7/fixture.md'],
    ...overrides,
  };
}

test('internal manifest accepts an unsigned, content-addressed artifact', () => {
  assert.equal(validateManifest(manifest()).schemaVersion, 1);
});

test('manifest rejects an artifact whose measured version differs from the release version', () => {
  assert.throws(
    () => validateManifest(manifest({ artifacts: [artifact({ artifactVersion: '1.2.63' })] })),
    /every artifactVersion must match manifest.version/,
  );
});

test('signed channels reject unsigned artifacts', () => {
  assert.throws(
    () => validateManifest(manifest({ channel: 'private-signed' })),
    /only verified signed artifacts/,
  );
});

test('public RC requires the exact platform matrix', () => {
  const signed = (platform, arch, kind, file) =>
    artifact({
      platform,
      arch,
      kind,
      file,
      signature: 'verified',
      signingIdentity: `${platform} fixture identity`,
      signatureEvidenceRef: `${file}.signature.txt`,
    });
  const artifacts = [
    signed('macos', 'arm64', 'dmg', 'TokenLedger.dmg'),
    signed('windows', 'x86_64', 'msi', 'TokenLedger.msi'),
    signed('android', 'universal', 'apk', 'TokenLedger.apk'),
  ];
  const evidenceFor = (items) => [
    ...items.map(({ signatureEvidenceRef }) => ({
      kind: 'signature',
      file: signatureEvidenceRef,
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
    })),
    {
      kind: 'production-migration-history',
      file: 'production-migration-evidence.json',
      sizeBytes: 1,
      sha256: 'b'.repeat(64),
    },
    {
      kind: 'android-upgrade',
      file: 'android-upgrade-evidence.json',
      sizeBytes: 1,
      sha256: 'c'.repeat(64),
    },
  ];
  assert.throws(
    () =>
      validateManifest(
        manifest({ channel: 'public-rc', artifacts, evidence: evidenceFor(artifacts) }),
      ),
    /exactly four platform artifacts/,
  );
  artifacts.push(signed('android', 'universal', 'aab', 'TokenLedger.aab'));
  assert.equal(
    validateManifest(
      manifest({
        channel: 'public-rc',
        previousRelease: '1.2.63',
        artifacts,
        evidence: evidenceFor(artifacts),
      }),
    ).artifacts.length,
    4,
  );
});

test('public RC upgrade evidence is bound to the declared previous release', () => {
  const signed = (platform, arch, kind, file) =>
    artifact({
      platform,
      arch,
      kind,
      file,
      signature: 'verified',
      signingIdentity: `${platform} fixture identity`,
      signatureEvidenceRef: `${file}.signature.txt`,
    });
  const artifacts = [
    signed('macos', 'arm64', 'dmg', 'TokenLedger.dmg'),
    signed('windows', 'x86_64', 'msi', 'TokenLedger.msi'),
    signed('android', 'universal', 'apk', 'TokenLedger.apk'),
    signed('android', 'universal', 'aab', 'TokenLedger.aab'),
  ];
  const baseEvidence = [
    ...artifacts.map(({ signatureEvidenceRef }) => ({
      kind: 'signature',
      file: signatureEvidenceRef,
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
    })),
    {
      kind: 'production-migration-history',
      file: 'production-migration-evidence.json',
      sizeBytes: 1,
      sha256: 'b'.repeat(64),
    },
  ];
  const upgrade = {
    kind: 'android-upgrade',
    file: 'android-upgrade-evidence.json',
    sizeBytes: 1,
    sha256: 'c'.repeat(64),
  };

  // 省略 previousRelease：不能区分"忘了带证据"与"首个发布"，必须拒绝。
  assert.throws(
    () => validateManifest(manifest({ channel: 'public-rc', artifacts, evidence: [...baseEvidence, upgrade] })),
    /must declare previousRelease/,
  );
  // 首个公开发布：previousRelease 为 null，不得携带升级证据。
  assert.equal(
    validateManifest(manifest({ channel: 'public-rc', previousRelease: null, artifacts, evidence: baseEvidence }))
      .previousRelease,
    null,
  );
  assert.throws(
    () => validateManifest(manifest({ channel: 'public-rc', previousRelease: null, artifacts, evidence: [...baseEvidence, upgrade] })),
    /must not carry Android upgrade evidence/,
  );
  // 有上一版：恰好一份证据，且上一版必须更旧。
  assert.throws(
    () => validateManifest(manifest({ channel: 'public-rc', previousRelease: '1.2.63', artifacts, evidence: baseEvidence })),
    /exactly one Android 1\.2\.63 to 1\.2\.64 upgrade evidence/,
  );
  assert.throws(
    () => validateManifest(manifest({ channel: 'public-rc', previousRelease: '1.2.64', artifacts, evidence: [...baseEvidence, upgrade] })),
    /must be older than version/,
  );
});

test('file verification rejects a digest mismatch', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenledger-manifest-'));
  try {
    const file = path.join(directory, 'TokenLedger.apk');
    fs.writeFileSync(file, 'tokenledger-release-fixture');
    validateManifest(manifest(), { artifactsDir: directory });
    assert.throws(() => {
      fs.writeFileSync(file, 'tampered');
      validateManifest(manifest(), { artifactsDir: directory });
    }, /(size|SHA-256) does not match/);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test('unverified signatures cannot claim an identity or evidence', () => {
  assert.throws(
    () =>
      validateManifest(
        manifest({
          artifacts: [
            artifact({
              signature: 'unverified',
              signingIdentity: 'untrusted fixture',
              signatureEvidenceRef: 'not-verified.txt',
            }),
          ],
        }),
      ),
    /signingIdentity must be null/,
  );
});

test('JSON Schema and runtime agree on release-only fields and conditional gates', () => {
  const artifactSchema = schema.$defs.artifact;
  assert(artifactSchema.required.includes('buildEnvironment'));
  assert(artifactSchema.required.includes('artifactVersion'));
  assert(artifactSchema.properties.buildEnvironment);
  assert(artifactSchema.allOf.some((condition) => condition.else || condition.then?.not));
  assert(schema.required.includes('evidence'));
  assert(schema.$defs.evidence.properties.sha256);
  assert(
    schema.allOf.some(
      (condition) =>
        condition.if?.properties?.channel?.const === 'public-rc'
        && condition.then?.properties?.artifacts?.minItems === 4
        && condition.then?.properties?.artifacts?.maxItems === 4,
    ),
  );
  assert(
    schema.allOf.some((condition) =>
      condition.if?.properties?.channel?.enum?.includes('private-signed')),
  );
});

test('CI and signed release workflows record measured artifact versions', () => {
  const ciWorkflow = fs.readFileSync(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  const releaseWorkflow = fs.readFileSync(
    new URL('../.github/workflows/release-rc.yml', import.meta.url),
    'utf8',
  );
  assert.match(ciWorkflow, /VersionInfo\.ProductVersion/);
  assert.match(ciWorkflow, /package\.json/);
  assert.match(releaseWorkflow, /PlistBuddy.*CFBundleShortVersionString/);
  assert.match(releaseWorkflow, /apkanalyzer.*manifest version-name/);
  assert.equal((releaseWorkflow.match(/--artifact-version/g) ?? []).length, 4);
});

test('generator hashes descriptors and requires non-empty signature evidence', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenledger-descriptor-'));
  try {
    fs.writeFileSync(path.join(directory, 'TokenLedger.apk'), 'signed-fixture');
    fs.writeFileSync(path.join(directory, 'signature.txt'), 'verified fixture signature');
    fs.writeFileSync(
      path.join(directory, 'android.artifact.json'),
      JSON.stringify({
        schemaVersion: 1,
        artifact: {
          path: 'TokenLedger.apk',
          platform: 'android',
          arch: 'universal',
          kind: 'apk',
          artifactVersion: packageVersion,
          signature: 'verified',
          signingIdentity: `sha256:${'a'.repeat(64)}`,
          signatureEvidenceRef: 'signature.txt',
          buildEnvironment: 'node test',
        },
      }),
    );
    fs.writeFileSync(
      path.join(directory, 'spec.json'),
      JSON.stringify({
        channel: 'internal',
        validationRefs: ['node:test'],
        artifacts: ['android.artifact.json'],
      }),
    );
    const output = path.join(directory, 'manifest.json');
    const generated = spawnSync(
      process.execPath,
      [manifestCli, 'generate', '--spec', path.join(directory, 'spec.json'), '--output', output],
      { encoding: 'utf8' },
    );
    assert.equal(generated.status, 0, generated.stderr);
    const value = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(value.artifacts[0].signatureEvidenceRef, 'signature.txt');
    assert.equal(value.evidence[0].file, 'signature.txt');
    assert.equal(value.artifacts[0].sha256.length, 64);

    fs.rmSync(path.join(directory, 'signature.txt'));
    const missingEvidence = spawnSync(
      process.execPath,
      [manifestCli, 'generate', '--spec', path.join(directory, 'spec.json'), '--output', output],
      { encoding: 'utf8' },
    );
    assert.notEqual(missingEvidence.status, 0);
    assert.match(missingEvidence.stderr, /signature\.txt/);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

for (const version of ['1.2.66', '2.0.0']) {
test(`public assembly binds measured production evidence to candidate ${version}`, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenledger-public-manifest-'));
  const sourceSha = '1'.repeat(40);
  const migration = '20260728021444_m10_release_security_hardening';
  try {
    const descriptors = [
      ['macos', 'arm64', 'dmg', 'TokenLedger.dmg', 'macos-signature.txt'],
      ['windows', 'x86_64', 'msi', 'TokenLedger.msi', 'windows-signature.txt'],
      ['android', 'universal', 'apk', 'TokenLedger.apk', 'android-apk-signature.txt'],
      ['android', 'universal', 'aab', 'TokenLedger.aab', 'android-aab-signature.txt'],
    ];
    for (const [platform, arch, kind, file, signatureEvidenceRef] of descriptors) {
      fs.writeFileSync(path.join(directory, file), `${platform}-${kind}-artifact`);
      fs.writeFileSync(path.join(directory, signatureEvidenceRef), `${platform}-${kind}-verified`);
      fs.writeFileSync(
        path.join(directory, `${kind}.artifact.json`),
        JSON.stringify({
          schemaVersion: 1,
          artifact: {
            path: file,
            platform,
            arch,
            kind,
            artifactVersion: version,
            signature: 'verified',
            signingIdentity: `${platform}-measured-identity`,
            signatureEvidenceRef,
            buildEnvironment: 'GitHub Actions fixture',
          },
        }),
      );
    }
    fs.writeFileSync(
      path.join(directory, 'production-migration-evidence.json'),
      JSON.stringify({
        schemaVersion: 1,
        evidenceType: 'production-supabase-migration-history',
        generatedAt: '2026-07-28T03:00:00.000Z',
        sourceSha,
        projectRef: 'abcdefghijklmnopqrst',
        databaseProjectBinding: 'pooler-role-suffix',
        clientProjectBinding: 'standard-project-hostname',
        workflowRun: {
          repository: 'tokenledger/fixture',
          workflow: 'TokenLedger Signed RC',
          runId: '42',
          runAttempt: '1',
          refName: `v${version}`,
        },
        supabaseCliVersion: '2.109.1',
        command: [
          'supabase',
          'migration',
          'list',
          '--db-url',
          '<protected-read-only-db-url>',
        ],
        repositoryMigrations: [migration],
        localVersions: [migration.slice(0, 14)],
        remoteVersions: [migration.slice(0, 14)],
        remoteHeadVersion: migration.slice(0, 14),
        verifiedMigrationHead: migration,
        exactHistoryMatch: true,
        historySha256: createHash('sha256')
          .update(JSON.stringify([migration.slice(0, 14)]))
          .digest('hex'),
      }),
    );
    fs.writeFileSync(
      path.join(directory, 'android-upgrade-evidence.json'),
      JSON.stringify({
        schemaVersion: 1,
        evidenceType: 'android-signed-upgrade',
        generatedAt: '2026-07-28T03:01:00.000Z',
        sourceSha,
        applicationId: 'com.jeidorf.tokenledger.mobile',
        privateRelease: {
          versionName: '1.2.65',
          versionCode: 10265,
          apkSha256: 'b'.repeat(64),
          signerSha256: 'a'.repeat(64),
          workflowRun: {
            id: '41',
            url: 'https://github.com/tokenledger/fixture/actions/runs/41',
            headSha: '2'.repeat(40),
          },
        },
        publicRc: {
          versionName: version,
          versionCode: 10266,
          apkSha256: 'c'.repeat(64),
          signerSha256: 'a'.repeat(64),
          workflowRun: {
            id: '42',
            url: 'https://github.com/tokenledger/fixture/actions/runs/42',
          },
        },
        assertions: {
          sameApplicationId: true,
          versionCodeIncreased: true,
          sameSigningCertificate: true,
          bothNonDebuggable: true,
        },
      }),
    );

    const output = path.join(directory, 'release-manifest.json');
    const args = [
      manifestCli,
      'assemble',
      '--descriptor-root',
      directory,
      '--channel',
      'public-rc',
      '--version',
      version,
      '--previous-release',
      '1.2.65',
      '--source-sha',
      sourceSha,
      '--supabase-migration-head',
      migration,
      '--validation-ref',
      'github:fixture/run/42',
      '--output',
      output,
    ];
    const assembled = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(assembled.status, 0, assembled.stderr);
    const value = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(value.supabaseMigrationHead, migration);
    assert.equal(value.evidence.length, 6);

    const injected = [...args];
    injected[injected.indexOf(migration)] = '20260729000000_injected_head';
    const rejected = spawnSync(process.execPath, injected, { encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /differs from the content-addressed production evidence/);

    const evidenceFile = path.join(directory, 'production-migration-evidence.json');
    const originalEvidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    for (const refName of ['v1.2.65', 'v3.0.0', version, `v${version}-rc.1`, `v${version} `]) {
      fs.writeFileSync(evidenceFile, JSON.stringify({
        ...originalEvidence, workflowRun: { ...originalEvidence.workflowRun, refName },
      }));
      const wrongTag = spawnSync(process.execPath, args, { encoding: 'utf8' });
      assert.notEqual(wrongTag.status, 0, `accepted wrong refName ${refName}`);
      assert.match(wrongTag.stderr, /workflow refName/);
    }
    fs.writeFileSync(evidenceFile, JSON.stringify({ ...originalEvidence, sourceSha: '2'.repeat(40) }));
    const wrongSha = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.notEqual(wrongSha.status, 0);
    assert.match(wrongSha.stderr, /source SHA differs/);

    fs.writeFileSync(evidenceFile, JSON.stringify(originalEvidence));
    fs.rmSync(path.join(directory, 'android-upgrade-evidence.json'));
    const firstReleaseArgs = [...args];
    firstReleaseArgs[firstReleaseArgs.indexOf('--previous-release') + 1] = 'none';
    const firstRelease = spawnSync(process.execPath, firstReleaseArgs, { encoding: 'utf8' });
    assert.equal(firstRelease.status, 0, firstRelease.stderr);
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).previousRelease, null);

  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
}
