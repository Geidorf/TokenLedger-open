import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  throw new Error(message);
}

function parseArgs(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      fail(`invalid argument ${flag ?? '<missing>'}`);
    }
    options.set(flag.slice(2), value);
  }
  return options;
}

function requireFile(options, name) {
  const value = options.get(name);
  if (!value) {
    fail(`--${name} is required`);
  }
  const absolutePath = path.resolve(value);
  if (!fs.statSync(absolutePath, { throwIfNoEntry: false })?.isFile()) {
    fail(`${absolutePath} is not a readable APK`);
  }
  return absolutePath;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) {
    fail(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return `${result.stdout}${result.stderr}`.trim();
}

function androidTool(name) {
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!androidHome) {
    fail('ANDROID_HOME or ANDROID_SDK_ROOT is required');
  }
  if (name === 'apkanalyzer') {
    const candidates = [
      path.join(androidHome, 'cmdline-tools', 'latest', 'bin', name),
      path.join(androidHome, 'tools', 'bin', name),
    ];
    const result = candidates.find((candidate) => fs.existsSync(candidate));
    if (!result) {
      fail('apkanalyzer was not found in the Android SDK');
    }
    return result;
  }
  const buildTools = path.join(androidHome, 'build-tools');
  const versions = fs
    .readdirSync(buildTools)
    .filter((entry) => fs.statSync(path.join(buildTools, entry)).isDirectory())
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const result = versions.length > 0 ? path.join(buildTools, versions.at(-1), name) : null;
  if (!result || !fs.existsSync(result)) {
    fail(`${name} was not found in the Android SDK`);
  }
  return result;
}

function inspect(apk, apksigner, apkanalyzer) {
  const signature = run(apksigner, ['verify', '--verbose', '--print-certs', apk]);
  const digest = signature.match(/certificate SHA-256 digest:\s*([0-9a-f:]+)/i)?.[1]
    ?.replaceAll(':', '')
    .toLowerCase();
  if (!digest || !/^[0-9a-f]{64}$/.test(digest)) {
    fail(`unable to read signer SHA-256 from ${apk}`);
  }
  const applicationId = run(apkanalyzer, ['manifest', 'application-id', apk]);
  const versionName = run(apkanalyzer, ['manifest', 'version-name', apk]);
  const versionCodeText = run(apkanalyzer, ['manifest', 'version-code', apk]);
  const versionCode = Number.parseInt(versionCodeText, 10);
  const manifest = run(apkanalyzer, ['manifest', 'print', apk]);
  if (/android:debuggable\s*=\s*"true"/i.test(manifest)) {
    fail(`${apk} is debuggable`);
  }
  return {
    applicationId,
    versionName,
    versionCode,
    signerSha256: digest,
    sha256: createHash('sha256').update(fs.readFileSync(apk)).digest('hex'),
    debuggable: false,
  };
}

function parseVersionName(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(String(text ?? '').trim());
  return match ? match.slice(1, 4).map((part) => Number.parseInt(part, 10)) : null;
}

function isOlderVersionName(left, right) {
  const a = parseVersionName(left);
  const b = parseVersionName(right);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index];
  }
  return false;
}

// `transition`（可选）由工作流从 release-lineage 解析结果传入：
// { previousVersion, currentVersion }。缺省时只要求版本名严格递增。
export function validateUpgradeInspections(first, second, transition = null) {
  for (const inspection of [first, second]) {
    if (!Number.isSafeInteger(inspection.versionCode) || inspection.versionCode <= 0) {
      fail(`invalid Android versionCode ${inspection.versionCode}`);
    }
    if (inspection.debuggable !== false) {
      fail('formal Android upgrade artifacts must not be debuggable');
    }
  }
  for (const [label, value] of [
    ['private applicationId', first.applicationId],
    ['RC applicationId', second.applicationId],
  ]) {
    if (value !== 'com.jeidorf.tokenledger.mobile') {
      fail(`${label} is ${value}`);
    }
  }
  if (transition) {
    if (
      first.versionName !== transition.previousVersion
      || second.versionName !== transition.currentVersion
    ) {
      fail(
        `expected ${transition.previousVersion} -> ${transition.currentVersion}, `
        + `got ${first.versionName} -> ${second.versionName}`,
      );
    }
  } else if (!isOlderVersionName(first.versionName, second.versionName)) {
    fail(`upgrade must move to a newer versionName, got ${first.versionName} -> ${second.versionName}`);
  }
  if (second.versionCode <= first.versionCode) {
    fail(`RC versionCode ${second.versionCode} must be greater than private ${first.versionCode}`);
  }
  if (first.signerSha256 !== second.signerSha256) {
    fail('previous release and RC APKs are signed by different certificates');
  }
  return {
    sameApplicationId: true,
    versionCodeIncreased: true,
    sameSigningCertificate: true,
    bothNonDebuggable: true,
  };
}

function writeEvidence(file, value) {
  const absolutePath = path.resolve(file);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`);
  return absolutePath;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const privateApk = requireFile(options, 'private-apk');
  const rcApk = requireFile(options, 'rc-apk');
  const apksigner = androidTool(process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
  const apkanalyzer = androidTool(process.platform === 'win32' ? 'apkanalyzer.bat' : 'apkanalyzer');
  const first = inspect(privateApk, apksigner, apkanalyzer);
  const second = inspect(rcApk, apksigner, apkanalyzer);
  const transition = options.has('previous-version') || options.has('rc-version')
    ? {
      previousVersion: options.get('previous-version') ?? fail('--previous-version is required with --rc-version'),
      currentVersion: options.get('rc-version') ?? fail('--rc-version is required with --previous-version'),
    }
    : null;
  const assertions = validateUpgradeInspections(first, second, transition);

  if (options.has('output')) {
    const privateRunId = options.get('private-run-id');
    const privateRunUrl = options.get('private-run-url');
    const privateRunSha = options.get('private-run-sha');
    const repository = process.env.GITHUB_REPOSITORY?.trim();
    const publicRunId = process.env.GITHUB_RUN_ID?.trim();
    const sourceSha = process.env.GITHUB_SHA?.trim();
    if (
      !privateRunId
      || !privateRunUrl
      || !/^[0-9a-f]{40}$/.test(privateRunSha ?? '')
      || !repository
      || !/^[1-9][0-9]*$/.test(publicRunId ?? '')
      || !/^[0-9a-f]{40}$/.test(sourceSha ?? '')
    ) {
      fail('upgrade evidence requires private/public workflow metadata and GITHUB_SHA');
    }
    const expectedPrivateRunUrl =
      `https://github.com/${repository}/actions/runs/${privateRunId}`;
    if (!/^[1-9][0-9]*$/.test(privateRunId) || privateRunUrl !== expectedPrivateRunUrl) {
      fail('private Android workflow run metadata does not belong to this repository');
    }
    const evidenceFile = writeEvidence(options.get('output'), {
      schemaVersion: 1,
      evidenceType: 'android-signed-upgrade',
      generatedAt: new Date().toISOString(),
      sourceSha,
      applicationId: 'com.jeidorf.tokenledger.mobile',
      privateRelease: {
        versionName: first.versionName,
        versionCode: first.versionCode,
        apkSha256: first.sha256,
        signerSha256: first.signerSha256,
        workflowRun: {
          id: privateRunId,
          url: privateRunUrl,
          headSha: privateRunSha,
        },
      },
      publicRc: {
        versionName: second.versionName,
        versionCode: second.versionCode,
        apkSha256: second.sha256,
        signerSha256: second.signerSha256,
        workflowRun: {
          id: publicRunId,
          url: `https://github.com/${repository}/actions/runs/${publicRunId}`,
        },
      },
      assertions,
    });
    console.log(`Android signed-upgrade evidence written: ${evidenceFile}.`);
  }
  console.log(
    `Android upgrade artifacts verified: ${first.versionName} (${first.versionCode}) -> `
      + `${second.versionName} (${second.versionCode}), signer SHA-256 `
      + `${first.signerSha256}.`,
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`Android upgrade artifact verification failed: ${error.message}`);
    process.exit(1);
  }
}
